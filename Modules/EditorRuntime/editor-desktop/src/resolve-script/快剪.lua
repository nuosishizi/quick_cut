--[[
  快剪 QuickCut — DaVinci Resolve 接收脚本
  Copyright (c) 2026 HX

  把本文件放到达芬奇脚本目录后，在达芬奇里点：
    工作区 → 脚本 → 快剪
  脚本会读取快剪写入的任务，把带样式的 Text+ 铺到当前时间线。
  本文件为快剪原创，只调用 Blackmagic 公开的 Resolve / Fusion API。
]]

local function env_global(name)
  return rawget(_G, name)
end

local function describe_env()
  local names = { "resolve", "Resolve", "fusion", "fu", "app", "bmd" }
  local parts = {}
  for _, name in ipairs(names) do
    parts[#parts + 1] = name .. "=" .. type(env_global(name))
  end
  return table.concat(parts, ",")
end

-- 菜单脚本里达芬奇注入的是小写 resolve。Resolve() 给外部脚本用，这里调用常会得到 nil。
local function get_resolve()
  local app = env_global("resolve")
  if app ~= nil then
    return app
  end
  local ctor = env_global("Resolve")
  if type(ctor) == "function" then
    local ok, value = pcall(ctor)
    if ok and value ~= nil then
      return value
    end
  end
  local fusion_app = env_global("fusion") or env_global("fu")
  if fusion_app ~= nil and type(fusion_app.GetResolve) == "function" then
    local ok, value = pcall(function()
      return fusion_app:GetResolve()
    end)
    if ok and value ~= nil then
      return value
    end
  end
  return nil
end

local function wait(seconds)
  local span = tonumber(seconds) or 0.25
  if span < 0.05 then span = 0.05 end
  if type(bmd) == "table" and type(bmd.wait) == "function" then
    bmd.wait(span)
    return
  end
  local deadline = os.clock() + span
  while os.clock() < deadline do
  end
end

local function join_path(a, b)
  local sep = package.config:sub(1, 1)
  if a:sub(-1) == "/" or a:sub(-1) == "\\" then
    return a .. b
  end
  return a .. sep .. b
end

local function link_root()
  local appdata = os.getenv("APPDATA")
  if appdata and appdata ~= "" then
    return join_path(join_path(appdata, "QuickCut"), "resolve-link")
  end
  local home = os.getenv("HOME") or ""
  return join_path(join_path(join_path(home, "Library"), "Application Support"), "QuickCut") ..
    package.config:sub(1, 1) .. "resolve-link"
end

local function read_all(path)
  local file, err = io.open(path, "rb")
  if not file then
    return nil, err
  end
  local data = file:read("*a")
  file:close()
  return data
end

local function write_all(path, text)
  local file, err = io.open(path, "wb")
  if not file then
    return nil, err
  end
  file:write(text or "")
  file:close()
  return true
end

local function append_log(root, message)
  if not root then
    print("[快剪] " .. tostring(message))
    return
  end
  local path = join_path(root, "script.log")
  local file = io.open(path, "ab")
  if file then
    file:write(os.date("%H:%M:%S") .. " " .. tostring(message) .. "\n")
    file:close()
  end
  print("[快剪] " .. tostring(message))
end

local function rotate_log_if_huge(root)
  local path = join_path(root, "script.log")
  local raw = read_all(path)
  if raw and #raw > 200000 then
    write_all(path, raw:sub(-80000))
  end
end

local function decode_json(text)
  local source = tostring(text or "")
  local index = 1
  local function fail(message)
    error(message .. " at " .. tostring(index))
  end
  local function peek()
    return source:sub(index, index)
  end
  local function skip()
    while source:sub(index, index):match("%s") do
      index = index + 1
    end
  end
  local function parse_value()
    skip()
    local ch = peek()
    if ch == '"' then
      index = index + 1
      local parts = {}
      while index <= #source do
        local current = source:sub(index, index)
        if current == '"' then
          index = index + 1
          return table.concat(parts)
        end
        if current == "\\" then
          local escaped = source:sub(index + 1, index + 1)
          if escaped == "u" then
            local hex = source:sub(index + 2, index + 5)
            local code = tonumber(hex, 16) or 32
            if code < 128 then
              parts[#parts + 1] = string.char(code)
            elseif code < 2048 then
              parts[#parts + 1] = string.char(192 + math.floor(code / 64), 128 + (code % 64))
            else
              parts[#parts + 1] = string.char(
                224 + math.floor(code / 4096),
                128 + (math.floor(code / 64) % 64),
                128 + (code % 64)
              )
            end
            index = index + 6
          else
            local mapped = ({
              ['"'] = '"',
              ["\\"] = "\\",
              ["/"] = "/",
              b = "\b",
              f = "\f",
              n = "\n",
              r = "\r",
              t = "\t",
            })[escaped] or escaped
            parts[#parts + 1] = mapped
            index = index + 2
          end
        else
          parts[#parts + 1] = current
          index = index + 1
        end
      end
      fail("unterminated string")
    elseif ch == "{" then
      index = index + 1
      local object = {}
      skip()
      if peek() == "}" then
        index = index + 1
        return object
      end
      while true do
        skip()
        if peek() ~= '"' then
          fail("object key")
        end
        local key = parse_value()
        skip()
        if peek() ~= ":" then
          fail("colon")
        end
        index = index + 1
        object[key] = parse_value()
        skip()
        local next_ch = peek()
        if next_ch == "}" then
          index = index + 1
          return object
        end
        if next_ch ~= "," then
          fail("comma")
        end
        index = index + 1
      end
    elseif ch == "[" then
      index = index + 1
      local array = {}
      skip()
      if peek() == "]" then
        index = index + 1
        return array
      end
      while true do
        array[#array + 1] = parse_value()
        skip()
        local next_ch = peek()
        if next_ch == "]" then
          index = index + 1
          return array
        end
        if next_ch ~= "," then
          fail("comma")
        end
        index = index + 1
      end
    elseif source:sub(index, index + 3) == "true" then
      index = index + 4
      return true
    elseif source:sub(index, index + 4) == "false" then
      index = index + 5
      return false
    elseif source:sub(index, index + 3) == "null" then
      index = index + 4
      return nil
    else
      local start = index
      if peek() == "-" then
        index = index + 1
      end
      if not source:sub(index, index):match("%d") then
        fail("number")
      end
      while source:sub(index, index):match("[%d.eE+-]") do
        index = index + 1
      end
      return tonumber(source:sub(start, index - 1))
    end
  end
  return parse_value()
end

local function json_escape(value)
  return tostring(value or "")
    :gsub("\\", "\\\\")
    :gsub('"', '\\"')
    :gsub("\n", "\\n")
    :gsub("\r", "\\r")
    :gsub("\t", "\\t")
end

local function write_json_file(path, fields)
  local parts = { "{" }
  local first = true
  for _, pair in ipairs(fields) do
    if not first then
      parts[#parts + 1] = ","
    end
    first = false
    local key, value = pair[1], pair[2]
    parts[#parts + 1] = '"' .. key .. '":'
    local kind = type(value)
    if kind == "number" then
      parts[#parts + 1] = tostring(value)
    elseif kind == "boolean" then
      parts[#parts + 1] = value and "true" or "false"
    else
      parts[#parts + 1] = '"' .. json_escape(value) .. '"'
    end
  end
  parts[#parts + 1] = "}"
  return write_all(path, table.concat(parts))
end

local function now_unix()
  return os.time()
end

-- 免费版达芬奇不允许脚本自绘窗口，会弹出 Studio 购买提示。这里只用系统提示。
local function write_utf8_bom(path, text)
  return write_all(path, "\239\187\191" .. tostring(text or ""))
end

local function notify_user(root, title, text)
  local appdata = os.getenv("APPDATA")
  if appdata and appdata ~= "" then
    local script = join_path(root, "notify.ps1")
    local body = string.format(
      'Add-Type -AssemblyName System.Windows.Forms\r\n[void][System.Windows.Forms.MessageBox]::Show(%q, %q, "OK", "Information")\r\n',
      tostring(text or ""),
      tostring(title or "快剪")
    )
    write_utf8_bom(script, body)
    os.execute('powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' .. script .. '"')
    return
  end
  local home = os.getenv("HOME")
  if home and home ~= "" then
    local escaped = tostring(text or ""):gsub("\\", "\\\\"):gsub('"', '\\"')
    local named = tostring(title or "快剪"):gsub("\\", "\\\\"):gsub('"', '\\"')
    os.execute('osascript -e "display notification \\"' .. escaped .. '\\" with title \\"' .. named .. '\\""')
  end
end

local function write_progress(root, fields)
  local phase = fields.phase or "idle"
  local message = fields.message or ""
  local done = tonumber(fields.done) or 0
  local total = tonumber(fields.total) or 0
  local percent = 0
  if total > 0 then
    percent = math.floor((done / total) * 100 + 0.5)
    if percent > 100 then
      percent = 100
    end
  elseif phase == "done" then
    percent = 100
  end
  write_json_file(join_path(root, "progress.json"), {
    { "listening", true },
    { "phase", phase },
    { "message", message },
    { "done", done },
    { "total", total },
    { "percent", percent },
    { "jobId", tostring(fields.jobId or "") },
    { "error", tostring(fields.error or "") },
    { "updated", now_unix() },
  })
  write_json_file(join_path(root, "listener.json"), {
    { "running", true },
    { "updated", now_unix() },
    { "app", "快剪" },
    { "phase", phase },
    { "message", message },
  })
end

local function json_escape_field(value)
  return tostring(value or "")
    :gsub("\\", "\\\\")
    :gsub('"', '\\"')
    :gsub("\n", "\\n")
end

local function heartbeat(root)
  write_json_file(join_path(root, "listener.json"), {
    { "running", true },
    { "updated", now_unix() },
    { "app", "快剪" },
  })
end

local function frame_rate_of(timeline)
  local raw = nil
  pcall(function()
    raw = timeline:GetSetting("timelineFrameRate")
  end)
  local fps = tonumber(raw) or 30
  if fps <= 0 then
    fps = 30
  end
  return fps
end

local function nominal_rate(fps)
  if math.abs(fps - 29.97) < 0.03 then
    return 30
  end
  if math.abs(fps - 23.976) < 0.03 then
    return 24
  end
  if math.abs(fps - 59.94) < 0.03 then
    return 60
  end
  local rounded = math.floor(fps + 0.5)
  if rounded < 1 then
    return 30
  end
  return rounded
end

local function first_picture_frame(timeline, start_frame)
  local origin = tonumber(start_frame) or 0
  if origin >= 0 then
    return origin
  end
  -- 时间线起点为负数时，画面素材通常从 0 起。再用 GetStartFrame 会把字幕写到画面前面。
  local picture = nil
  pcall(function()
    local items = timeline:GetItemListInTrack("video", 1)
    if type(items) == "table" then
      for _, item in ipairs(items) do
        local name = ""
        pcall(function()
          name = item:GetName() or ""
        end)
        if name:find("快剪", 1, true) ~= 1 and name:find("Fusion Clip", 1, true) ~= 1 then
          local at = item:GetStart()
          if at ~= nil and (picture == nil or at < picture) then
            picture = at
          end
        end
      end
    end
  end)
  if picture ~= nil then
    return picture
  end
  return 0
end

local function frames_to_timecode(frame, fps)
  local rate = nominal_rate(fps)
  local whole = math.floor(tonumber(frame) or 0)
  if whole < 0 then
    whole = 0
  end
  local ff = whole % rate
  local total_seconds = math.floor(whole / rate)
  local ss = total_seconds % 60
  local total_minutes = math.floor(total_seconds / 60)
  local mm = total_minutes % 60
  local hh = math.floor(total_minutes / 60)
  return string.format("%02d:%02d:%02d:%02d", hh, mm, ss, ff)
end

local function find_text_tool(comp)
  if not comp then
    return nil
  end
  local tool = nil
  pcall(function()
    tool = comp:FindToolByID("TextPlus")
  end)
  if tool then
    return tool
  end
  local names = { "TextPlus1", "Text1", "Template", "TextPlus", "Text" }
  for _, name in ipairs(names) do
    pcall(function()
      tool = comp:FindTool(name)
    end)
    if tool then
      return tool
    end
  end
  pcall(function()
    local list = comp:GetToolList(false, "TextPlus")
    if type(list) == "table" then
      tool = list[1] or list[0]
      if not tool then
        for _, value in pairs(list) do
          tool = value
          break
        end
      end
    end
  end)
  return tool
end

local function get_item_comp(item)
  if not item then
    return nil, 0
  end
  local count = 0
  pcall(function()
    count = item:GetFusionCompCount() or 0
  end)
  local comp = nil
  if item.GetFusionCompByIndex then
    pcall(function()
      comp = item:GetFusionCompByIndex(1)
    end)
    if not comp then
      pcall(function()
        comp = item:GetFusionCompByIndex(0)
      end)
    end
  end
  if not comp and item.GetFusionCompNameList and item.GetFusionCompByName then
    local names = nil
    pcall(function()
      names = item:GetFusionCompNameList()
    end)
    if type(names) == "table" and names[1] then
      pcall(function()
        comp = item:GetFusionCompByName(names[1])
      end)
    end
  end
  return comp, count
end

local function add_text_tool(comp)
  if not comp or not comp.AddTool then
    return nil
  end
  local text = nil
  pcall(function()
    text = comp:AddTool("TextPlus")
  end)
  if not text then
    return nil
  end
  local media_out = nil
  pcall(function()
    media_out = comp:FindToolByID("MediaOut") or comp:FindTool("MediaOut1")
  end)
  if media_out then
    pcall(function()
      media_out:SetInput("Input", text)
    end)
  end
  return text
end

local function set_number(tool, key, value)
  if value == nil then
    return
  end
  pcall(function()
    tool:SetInput(key, value)
  end)
end

local function apply_rgb(tool, channel, color, alpha)
  if type(color) ~= "table" then
    return
  end
  local r = tonumber(color[1]) or 1
  local g = tonumber(color[2]) or 1
  local b = tonumber(color[3]) or 1
  local a = tonumber(alpha)
  if a == nil then
    a = 1
  end
  set_number(tool, "Red" .. channel, r)
  set_number(tool, "Green" .. channel, g)
  set_number(tool, "Blue" .. channel, b)
  set_number(tool, "Alpha" .. channel, a)
end

local function apply_style(comp, tool, item, style)
  if not tool then
    return false
  end
  pcall(function()
    tool:SetInput("Direction", 0)
  end)
  if style.fontFamily and style.fontFamily ~= "" then
    pcall(function()
      tool:SetInput("Font", style.fontFamily)
    end)
  end
  if style.fontStyle and style.fontStyle ~= "" then
    pcall(function()
      tool:SetInput("Style", style.fontStyle)
    end)
  end
  set_number(tool, "Size", tonumber(style.size) or 0.06)
  pcall(function()
    tool:SetInput("Center", { tonumber(style.centerX) or 0.5, tonumber(style.centerY) or 0.22 })
  end)
  local align = tonumber(style.align)
  if align ~= nil then
    set_number(tool, "HorizontalJustificationNew", align)
  end
  set_number(tool, "Enabled1", 1)
  apply_rgb(tool, 1, style.color or item.color, 1)
  if style.strokeEnabled then
    set_number(tool, "Enabled2", 1)
    apply_rgb(tool, 2, style.strokeColor, 1)
    set_number(tool, "Thickness2", tonumber(style.stroke) or 0.06)
  end
  if style.shadowEnabled then
    set_number(tool, "Enabled3", 1)
    apply_rgb(tool, 3, style.shadowColor, 1)
  end
  local plain = tostring(item.text or "")
  pcall(function()
    tool:SetInput("StyledText", plain)
  end)
  pcall(function()
    tool:SetInput("Text", plain)
  end)
  return true
end

local function set_clip_span(item, start_frame, end_frame, root)
  if not item then
    return
  end
  local duration = math.max(1, (tonumber(end_frame) or 1) - (tonumber(start_frame) or 0))
  local actual = nil
  pcall(function()
    actual = item:GetStart()
  end)
  if actual ~= nil and math.abs(actual - start_frame) > 2 then
    append_log(root, string.format(
      "span keep inserted_start=%s expected=%s duration=%s",
      tostring(actual),
      tostring(start_frame),
      tostring(duration)
    ))
    pcall(function()
      item:SetProperty("End", actual + duration)
    end)
    pcall(function()
      item:SetProperty("Duration", duration)
    end)
    return actual
  end
  pcall(function()
    item:SetProperty("Start", start_frame)
    item:SetProperty("End", end_frame)
    item:SetProperty("Duration", duration)
  end)
  return start_frame
end

local function unlock_all_video(timeline)
  local count = timeline:GetTrackCount("video") or 0
  for track = 1, count do
    pcall(function()
      timeline:SetTrackLock("video", track, false)
    end)
  end
end

local function find_or_add_caption_track(timeline)
  local count = timeline:GetTrackCount("video") or 0
  for track = 1, count do
    local name = ""
    pcall(function()
      name = timeline:GetTrackName("video", track) or ""
    end)
    if name == "快剪字幕" then
      return track
    end
  end
  pcall(function()
    timeline:AddTrack("video")
  end)
  local index = timeline:GetTrackCount("video") or 1
  pcall(function()
    timeline:SetTrackName("video", index, "快剪字幕")
  end)
  return index
end

local function describe_item(item)
  if not item then
    return "item=nil"
  end
  local name, start_at, ending, duration, comps = "?", "?", "?", "?", "?"
  pcall(function() name = item:GetName() end)
  pcall(function() start_at = item:GetStart() end)
  pcall(function() ending = item:GetEnd() end)
  pcall(function() duration = item:GetDuration() end)
  pcall(function() comps = item:GetFusionCompCount() end)
  return string.format(
    "name=%s start=%s end=%s duration=%s comps=%s",
    tostring(name),
    tostring(start_at),
    tostring(ending),
    tostring(duration),
    tostring(comps)
  )
end

local function clip_name(item)
  local name = ""
  pcall(function()
    name = item:GetName() or ""
  end)
  return name
end

local function is_quickcut_clip(item)
  local name = clip_name(item)
  return name:find("快剪字幕", 1, true) == 1
    or name:find("快剪模板", 1, true) == 1
    or name:find("QuickCutCap", 1, true) == 1
end

local function last_occupied_frame(timeline, start_frame)
  local last = tonumber(start_frame) or 0
  local tracks = timeline:GetTrackCount("video") or 0
  for track = 1, tracks do
    local items = nil
    pcall(function()
      items = timeline:GetItemListInTrack("video", track)
    end)
    if type(items) == "table" then
      for _, item in ipairs(items) do
        local ending = nil
        pcall(function()
          ending = item:GetEnd()
        end)
        if ending and ending > last then
          last = ending
        end
      end
    end
  end
  return last
end

local function restore_pushed_video(timeline, start_frame, root)
  local items = nil
  pcall(function()
    items = timeline:GetItemListInTrack("video", 1)
  end)
  if type(items) ~= "table" then
    return
  end
  for _, item in ipairs(items) do
    if not is_quickcut_clip(item) then
      local current = nil
      local duration = nil
      pcall(function()
        current = item:GetStart()
        duration = item:GetDuration() or ((item:GetEnd() or 0) - (current or 0))
      end)
      if current and current > start_frame + 1 then
        append_log(root, string.format(
          "restore video %s from %s to %s",
          clip_name(item),
          tostring(current),
          tostring(start_frame)
        ))
        pcall(function()
          item:SetProperty("Start", start_frame)
          item:SetProperty("End", start_frame + math.max(1, duration or 1))
        end)
      end
    end
  end
end

local function clear_previous(timeline)
  local count = timeline:GetTrackCount("video") or 0
  for track = 1, count do
    local track_name = ""
    pcall(function()
      track_name = timeline:GetTrackName("video", track) or ""
    end)
    local items = nil
    pcall(function()
      items = timeline:GetItemListInTrack("video", track)
    end)
    if type(items) ~= "table" or #items == 0 then
      goto continue_clear
    end
    local doomed = {}
    if track_name == "快剪字幕" then
      for _, item in ipairs(items) do
        doomed[#doomed + 1] = item
      end
    else
      for _, item in ipairs(items) do
        local name = ""
        pcall(function()
          name = item:GetName() or ""
        end)
        if name:find("快剪字幕", 1, true) == 1
          or name:find("QuickCutCap", 1, true) == 1
          or name == "Text+"
          or name == "Basic Template" then
          doomed[#doomed + 1] = item
        end
      end
    end
    if #doomed > 0 then
      pcall(function()
        timeline:DeleteClips(doomed)
      end)
    end
    ::continue_clear::
  end
end

local function try_set_destination_track(timeline, track_index)
  pcall(function()
    timeline:SetCurrentVideoDestinationTrack(track_index)
  end)
  pcall(function()
    timeline:SetDestinationTrack("video", track_index)
  end)
  pcall(function()
    timeline:SetCurrentVideoItemTrack(track_index)
  end)
end

local function call_insert(timeline, kind, name)
  local ok, result = pcall(function()
    if kind == "fusion_title" and type(timeline.InsertFusionTitleIntoTimeline) == "function" then
      return timeline:InsertFusionTitleIntoTimeline(name)
    end
    if kind == "title" and type(timeline.InsertTitleIntoTimeline) == "function" then
      return timeline:InsertTitleIntoTimeline(name)
    end
    if kind == "fusion_gen" and type(timeline.InsertFusionGeneratorIntoTimeline) == "function" then
      return timeline:InsertFusionGeneratorIntoTimeline(name)
    end
    if kind == "generator" and type(timeline.InsertGeneratorIntoTimeline) == "function" then
      return timeline:InsertGeneratorIntoTimeline(name)
    end
    if kind == "fusion_comp" and type(timeline.InsertFusionCompositionIntoTimeline) == "function" then
      return timeline:InsertFusionCompositionIntoTimeline()
    end
    return nil
  end)
  if ok and result then
    return result
  end
  return nil, ok and "nil" or tostring(result)
end

local insert_recipe = nil

local function insert_title(timeline, root)
  if insert_recipe then
    local item, err = call_insert(timeline, insert_recipe.kind, insert_recipe.name)
    if item then
      return item, insert_recipe.kind
    end
    append_log(root, "cached insert failed " .. insert_recipe.kind .. " " .. tostring(insert_recipe.name) .. " " .. tostring(err))
  end
  local names = { "Text+", "Text +", "文本+", "Text", "TextPlus", "Fusion Title", "标题", "简单文本" }
  local kinds = { "fusion_title", "title", "fusion_gen", "generator" }
  for _, kind in ipairs(kinds) do
    for _, name in ipairs(names) do
      local item, err = call_insert(timeline, kind, name)
      append_log(root, string.format("try %s %s -> %s", kind, name, item and "ok" or tostring(err)))
      if item then
        insert_recipe = { kind = kind, name = name }
        return item, kind
      end
    end
  end
  local item, err = call_insert(timeline, "fusion_comp", "")
  append_log(root, "try fusion_comp -> " .. (item and "ok" or tostring(err)))
  if item then
    insert_recipe = { kind = "fusion_comp", name = "" }
    return item, "fusion_comp"
  end
  return nil, "none"
end

local ANIMATED_CAPTION_DISPLAY_NAME = "AutoSubs Caption"
local AUTOSUBS_BIN = "快剪"

local function utf8len(s)
  local _, count = tostring(s or ""):gsub("[^\128-\191]", "")
  return count
end

local function walk_media_pool(folder, onClip)
  if not folder then return false end
  local ok, subfolders = pcall(function() return folder:GetSubFolderList() end)
  if ok and type(subfolders) == "table" then
    for _, subfolder in ipairs(subfolders) do
      local stop = walk_media_pool(subfolder, onClip)
      if stop then return true end
    end
  end
  local ok2, clips = pcall(function() return folder:GetClipList() end)
  if ok2 and type(clips) == "table" then
    for _, clip in ipairs(clips) do
      local stop = onClip(clip, folder)
      if stop then return true end
    end
  end
  return false
end

local function is_animated_caption(clipName)
  if type(clipName) ~= "string" then return false end
  return clipName == ANIMATED_CAPTION_DISPLAY_NAME
    or clipName:sub(1, #ANIMATED_CAPTION_DISPLAY_NAME + 1) == ANIMATED_CAPTION_DISPLAY_NAME .. " "
    or clipName == "快剪动态字幕"
    or clipName == "快剪Text+"
end

local function get_root_subfolder(rootFolder, folderName)
  local ok, subfolders = pcall(function() return rootFolder:GetSubFolderList() end)
  if ok and type(subfolders) == "table" then
    for _, subfolder in ipairs(subfolders) do
      local name = ""
      pcall(function() name = subfolder:GetName() or "" end)
      if name == folderName then
        return subfolder
      end
    end
  end
  return nil
end

local function find_template_item(rootFolder, templateName)
  local template, sourceBin = nil, nil
  walk_media_pool(rootFolder, function(clip, clipFolder)
    local props = nil
    pcall(function() props = clip:GetClipProperty() end)
    local clipName = (type(props) == "table" and props["Clip Name"]) or ""
    if clipName == "" then
      pcall(function() clipName = clip:GetName() or "" end)
    end
    if is_animated_caption(clipName) or (templateName and clipName == templateName) then
      template = clip
      sourceBin = clipFolder
      return true
    end
  end)
  return template, sourceBin
end

local function find_caption_bin_file(job, root)
  local candidates = {
    job and job.captionBinPath,
    join_path(root or link_root(), "caption-bin.drb"),
    join_path(link_root(), "caption-bin.drb"),
  }
  local appdata = os.getenv("APPDATA")
  if appdata and appdata ~= "" then
    candidates[#candidates + 1] = join_path(join_path(join_path(join_path(join_path(join_path(appdata, "Blackmagic Design"), "DaVinci Resolve"), "Support"), "Fusion"), "Scripts"), "Utility\\caption-bin.drb")
  end
  local home = os.getenv("HOME")
  if home and home ~= "" then
    candidates[#candidates + 1] = join_path(join_path(join_path(join_path(join_path(join_path(home, "Library"), "Application Support"), "Blackmagic Design"), "DaVinci Resolve"), "Fusion"), "Scripts/Utility/caption-bin.drb")
  end
  for _, path in ipairs(candidates) do
    if path and path ~= "" then
      local f = io.open(path, "rb")
      if f then
        f:close()
        return path
      end
    end
  end
  return nil
end

local function ensure_caption_template(mediaPool, rootFolder, job, root)
  local template = find_template_item(rootFolder, job and job.templateName)
  if template then
    return template
  end
  local binPath = find_caption_bin_file(job, root)
  if not binPath then
    append_log(root, "caption-bin.drb not found, will use standard Text+ fallback")
    return nil
  end
  append_log(root, "Importing caption template bin: " .. tostring(binPath))
  local prevFolder = nil
  pcall(function()
    prevFolder = mediaPool:GetCurrentFolder()
    mediaPool:SetCurrentFolder(rootFolder)
  end)
  local imported, importResult = pcall(function()
    return mediaPool:ImportFolderFromFile(binPath)
  end)
  if prevFolder then
    pcall(function() mediaPool:SetCurrentFolder(prevFolder) end)
  end
  if not imported or not importResult then
    append_log(root, "ImportFolderFromFile failed: " .. tostring(importResult))
    return nil
  end
  local targetBin = get_root_subfolder(rootFolder, AUTOSUBS_BIN)
  local sourceBin = nil
  template, sourceBin = find_template_item(rootFolder, job and job.templateName)
  if not template then
    append_log(root, "Imported bin did not contain animated caption template")
    return nil
  end
  if targetBin and sourceBin and sourceBin ~= targetBin then
    pcall(function()
      mediaPool:MoveClips({ template }, targetBin)
    end)
    local remaining = nil
    pcall(function() remaining = sourceBin:GetClipList() end)
    if type(remaining) == "table" and #remaining > 0 then
      pcall(function() mediaPool:DeleteClips(remaining) end)
    end
    pcall(function() mediaPool:DeleteFolders({ sourceBin }) end)
  end
  return template
end

local function to_word_timing(transcript_words, frameRate, segmentStart)
  local result = {}
  local startIndex = 0
  if type(transcript_words) ~= "table" then
    return result
  end
  for _, word in ipairs(transcript_words) do
    local token = tostring(word.word or word.display or word.text or "")
    local w_len = utf8len(token)
    if w_len > 0 then
      local w_start = tonumber(word.start) or segmentStart
      local w_end = tonumber(word["end"] or word.endFrame) or (w_start + 0.2)
      local endIndex = startIndex + w_len - 1
      table.insert(result, {
        startIndex = startIndex,
        endIndex   = endIndex,
        startFrame = math.max(0, math.floor((w_start - segmentStart) * frameRate)),
        endFrame   = math.max(1, math.floor((w_end - segmentStart) * frameRate)),
      })
      startIndex = endIndex + 1
    end
  end
  return result
end

local function place_captions_via_append(mediaPool, timeline, templateItem, captions, fps, origin, track_index, presetSettings, style, root, job_id)
  local clipList = {}
  for index, caption in ipairs(captions) do
    local start_seconds = tonumber(caption.start) or 0
    local end_seconds = tonumber(caption["end"]) or (start_seconds + 1)
    if end_seconds <= start_seconds then
      end_seconds = start_seconds + 0.2
    end
    local clip_start = origin + math.floor(start_seconds * fps + 0.5)
    local clip_end = origin + math.floor(end_seconds * fps + 0.5)
    local duration = math.max(1, clip_end - clip_start)
    table.insert(clipList, {
      mediaPoolItem = templateItem,
      mediaType = 1,
      startFrame = 0,
      endFrame = duration,
      recordFrame = clip_start,
      trackIndex = track_index,
    })
  end

  unlock_all_video(timeline)
  local appendOk, timelineItems = pcall(function()
    return mediaPool:AppendToTimeline(clipList)
  end)

  if not appendOk or type(timelineItems) ~= "table" or #timelineItems == 0 then
    append_log(root, "AppendToTimeline returned nil or empty, fallback to insert_title")
    return nil, "AppendToTimeline failed"
  end

  append_log(root, string.format("AppendToTimeline placed %d items on track %d", #timelineItems, track_index))
  local placed = 0
  local hasPreset = presetSettings ~= nil and type(presetSettings) == "table"

  for index, item in ipairs(timelineItems) do
    local caption = captions[index] or {}
    local plainText = tostring(caption.text or "")
    local ok, err = pcall(function()
      local compCount = 0
      pcall(function() compCount = item:GetFusionCompCount() or 0 end)
      if compCount > 0 then
        local comp = item:GetFusionCompByIndex(1)
        if comp then
          local autosubsTool = comp:FindTool("AutoSubs")
          local templateTool = comp:FindTool("Template") or comp:FindToolByID("TextPlus") or find_text_tool(comp)

          if autosubsTool then
            local framerate = tonumber(comp:GetPrefs("Comp.FrameFormat.Rate")) or fps
            local wordTiming = to_word_timing(caption.words, framerate, tonumber(caption.start) or 0)
            autosubsTool:SetData("WordTiming", wordTiming)

            if templateTool then
              templateTool:SetInput("Text", plainText)
            end

            local clsTool = comp:FindTool("CharacterLevelStyling1")
            if clsTool then
              pcall(clsTool.SetInput, clsTool, "Text", plainText)
            end

            if hasPreset then
              local setter = autosubsTool:GetData("SetInputValues")
              if setter and setter ~= "" then
                local setterFunc = loadstring(setter)
                if setterFunc then
                  pcall(setterFunc(), comp, autosubsTool, presetSettings)
                end
              end
            end
          elseif templateTool then
            apply_style(comp, templateTool, caption, style)
          end
        end
      end
      pcall(function() item:SetName(string.format("快剪字幕 %03d", index)) end)
      pcall(function() item:SetClipColor("Green") end)
    end)

    if ok then
      placed = placed + 1
    else
      append_log(root, string.format("styling clip #%d failed: %s", index, tostring(err)))
    end

    if index == 1 or index % 20 == 0 or index == #captions then
      write_progress(root, {
        phase = "writing",
        message = string.format("正在写入第 %d / %d 条字幕", placed, #captions),
        done = placed,
        total = #captions,
        jobId = job_id,
      })
    end
  end

  if placed > 0 and captions[1] and captions[1].start ~= nil then
    pcall(function()
      local first_frame = origin + math.floor((tonumber(captions[1].start) or 0) * fps + 0.5)
      timeline:SetCurrentTimecode(frames_to_timecode(first_frame, fps))
    end)
  end

  return {
    count = placed,
    track = track_index,
  }
end

local function place_captions(job, root)
  local resolve = get_resolve()
  if not resolve then
    return nil, "达芬奇脚本环境不可用（" .. describe_env() .. "）"
  end
  pcall(function()
    resolve:OpenPage("edit")
  end)
  local projectManager = resolve:GetProjectManager()
  local project = projectManager and projectManager:GetCurrentProject()
  if not project then
    return nil, "请先在达芬奇打开一个工程"
  end
  local timeline = project:GetCurrentTimeline()
  if not timeline then
    return nil, "请先在达芬奇打开一条时间线，并放好视频"
  end

  local captions = job.items or job.captions or {}
  if #captions == 0 then
    return nil, "任务里没有字幕"
  end

  local fps = tonumber(job.fps) or frame_rate_of(timeline)
  local start_frame = 0
  pcall(function()
    start_frame = timeline:GetStartFrame() or 0
  end)
  local end_frame = 0
  pcall(function()
    end_frame = timeline:GetEndFrame() or 0
  end)
  local current_tc = ""
  pcall(function()
    current_tc = timeline:GetCurrentTimecode() or ""
  end)
  local track_count = timeline:GetTrackCount("video") or 0
  append_log(root, string.format(
    "timeline name=%s fps=%s start_frame=%s end_frame=%s tc=%s video_tracks=%s captions=%s",
    tostring((timeline.GetName and timeline:GetName()) or ""),
    tostring(fps),
    tostring(start_frame),
    tostring(end_frame),
    tostring(current_tc),
    tostring(track_count),
    tostring(#captions)
  ))

  unlock_all_video(timeline)
  local track_index = find_or_add_caption_track(timeline)
  if job.replace ~= false then
    clear_previous(timeline)
  end
  restore_pushed_video(timeline, start_frame, root)
  append_log(root, "caption track=" .. tostring(track_index))
  try_set_destination_track(timeline, track_index)

  local style = job.style or {}
  local presetSettings = job.presetSettings
  local job_id = tostring(job.id or "")
  local origin = first_picture_frame(timeline, start_frame)

  -- Try batch AppendToTimeline with AutoSubs Caption template
  local mediaPool = project:GetMediaPool()
  if mediaPool then
    local rootFolder = mediaPool:GetRootFolder()
    if rootFolder then
      local templateItem = ensure_caption_template(mediaPool, rootFolder, job, root)
      if templateItem then
        append_log(root, "Using AutoSubs dynamic caption template via mediaPool:AppendToTimeline")
        local appendResult, appendErr = place_captions_via_append(
          mediaPool,
          timeline,
          templateItem,
          captions,
          fps,
          origin,
          track_index,
          presetSettings,
          style,
          root,
          job_id
        )
        if appendResult and appendResult.count and appendResult.count > 0 then
          append_log(root, string.format("Batch append succeeded, placed %d captions", appendResult.count))
          return appendResult
        end
        append_log(root, "Batch append failed: " .. tostring(appendErr) .. ", falling back to insert_title")
      end
    end
  end

  -- Fallback path: one Text+ per caption via insert_title
  append_log(root, "one Text+ per caption fallback mode")
  insert_recipe = nil
  local placed = 0
  local first_error = nil
  local ok, err = pcall(function()
    for index, caption in ipairs(captions) do
      local start_seconds = tonumber(caption.start) or 0
      local end_seconds = tonumber(caption["end"]) or (start_seconds + 1)
      if end_seconds <= start_seconds then
        end_seconds = start_seconds + 0.2
      end
      local clip_start = origin + math.floor(start_seconds * fps + 0.5)
      local clip_end = origin + math.floor(end_seconds * fps + 0.5)
      if clip_end <= clip_start then
        clip_end = clip_start + 1
      end
      pcall(function()
        timeline:SetCurrentTimecode(frames_to_timecode(clip_start, fps))
      end)
      local item = insert_title(timeline, root)
      if not item then
        if not first_error then
          first_error = "无法插入 Text+，请确认达芬奇版本支持 Fusion 标题"
        end
      else
        pcall(function()
          item:SetName(string.format("快剪字幕 %03d", index))
        end)
        pcall(function()
          item:SetClipColor("Orange")
        end)
        set_clip_span(item, clip_start, clip_end, root)
        local styleOk, styleErr = pcall(function()
          local comp = item.GetFusionCompByIndex and item:GetFusionCompCount() > 0 and item:GetFusionCompByIndex(1)
          local tool = find_text_tool(comp) or add_text_tool(comp)
          if not tool then
            error("找不到 Text+")
          end
          apply_style(comp, tool, caption, style)
        end)
        if styleOk then
          placed = placed + 1
          if index <= 3 then
            append_log(root, "insert Fusion Title Text+ " .. describe_item(item))
          end
        elseif not first_error then
          first_error = tostring(styleErr)
          append_log(root, "style failed " .. tostring(styleErr))
        end
      end
      if index == 1 or index % 20 == 0 or index == #captions then
        write_progress(root, {
          phase = "writing",
          message = string.format("正在写入第 %d / %d 条字幕", placed, #captions),
          done = placed,
          total = #captions,
          jobId = job_id,
        })
      end
      if index % 8 == 0 then
        wait(0.04)
      end
    end
  end)

  if not ok then
    return nil, tostring(err)
  end
  append_log(root, string.format("place done placed=%d total=%s error=%s", placed, tostring(#captions), tostring(first_error)))
  if placed == 0 then
    return nil, first_error or "没有成功写入任何字幕"
  end
  return {
    count = placed,
    warning = first_error,
    track = track_index,
  }
end

local function process_job(root)
  local job_path = join_path(root, "job.json")
  local working_path = join_path(root, "job.working.json")
  local result_path = join_path(root, "result.json")
  local raw = read_all(job_path)
  if not raw or raw == "" then
    if not read_all(result_path) then
      raw = read_all(working_path)
    end
    if not raw or raw == "" then
      return false
    end
  else
    os.remove(working_path)
    if not os.rename(job_path, working_path) then
      write_all(working_path, raw)
      os.remove(job_path)
    end
  end

  local ok, job = pcall(decode_json, raw)
  if not ok or type(job) ~= "table" then
    write_json_file(result_path, {
      { "ok", false },
      { "id", "" },
      { "error", "任务文件不是有效 JSON" },
    })
    os.remove(working_path)
    return true
  end

  write_progress(root, {
    phase = "writing",
    message = "达芬奇开始写入字幕",
    done = 0,
    total = type(job.items) == "table" and #job.items or 0,
    jobId = tostring(job.id or ""),
  })
  local placed, err = place_captions(job, root)
  if not placed then
    write_progress(root, {
      phase = "error",
      message = tostring(err or "写入失败"),
      done = 0,
      total = type(job.items) == "table" and #job.items or 0,
      jobId = tostring(job.id or ""),
      error = tostring(err or "写入失败"),
    })
    write_json_file(result_path, {
      { "ok", false },
      { "id", tostring(job.id or "") },
      { "error", tostring(err or "写入失败") },
    })
  else
    write_progress(root, {
      phase = "done",
      message = string.format("已写入 %d 条字幕", placed.count or 0),
      done = placed.count or 0,
      total = type(job.items) == "table" and #job.items or (placed.count or 0),
      jobId = tostring(job.id or ""),
    })
    write_json_file(result_path, {
      { "ok", true },
      { "id", tostring(job.id or "") },
      { "count", placed.count or 0 },
      { "warning", placed.warning or "" },
      { "track", placed.track or 0 },
    })
  end
  os.remove(working_path)
  return true
end

local function already_listening(root)
  local raw = read_all(join_path(root, "listener.json"))
  if not raw then
    return false
  end
  local ok, data = pcall(decode_json, raw)
  if not ok or type(data) ~= "table" then
    return false
  end
  local updated = tonumber(data.updated) or 0
  return (now_unix() - updated) <= 4
end

local function main()
  local root = link_root()
  rotate_log_if_huge(root)
  print("[快剪] 接收脚本已启动")
  print("[快剪] 任务目录: " .. root)
  print("[快剪] 环境: " .. describe_env())
  append_log(root, "start " .. describe_env())
  if already_listening(root) then
    print("[快剪] 已有接收脚本在运行，由它处理任务")
    append_log(root, "already listening")
    write_progress(root, {
      phase = "idle",
      message = "接收脚本已在运行，可直接回快剪点发送",
    })
    notify_user(root, "快剪", "接收已经在运行。请回到快剪点「发送到达芬奇」。")
    return
  end
  heartbeat(root)
  local app = get_resolve()
  if app then
    pcall(function()
      app:OpenPage("edit")
    end)
    append_log(root, "resolve ok")
    print("[快剪] 已连上当前工程，等待快剪发送字幕")
    write_progress(root, {
      phase = "idle",
      message = "达芬奇已连接，等待快剪发送字幕",
    })
    notify_user(
      root,
      "快剪",
      "快剪已连接达芬奇。请回到快剪点「发送到达芬奇」。关掉本提示后，脚本会在后台继续接收。"
    )
  else
    append_log(root, "resolve missing")
    print("[快剪] 还没拿到工程对象：" .. describe_env())
    write_progress(root, {
      phase = "error",
      message = "达芬奇脚本环境不可用（" .. describe_env() .. "）",
      error = "达芬奇脚本环境不可用",
    })
  end
  process_job(root)

  print("[快剪] 正在等待快剪发送字幕。可继续使用达芬奇。")
  local started = now_unix()
  while now_unix() - started < 8 * 60 * 60 do
    heartbeat(root)
    process_job(root)
    if read_all(join_path(root, "stop")) then
      os.remove(join_path(root, "stop"))
      break
    end
    wait(0.35)
  end
  write_progress(root, {
    phase = "stopped",
    message = "接收脚本已结束，请重新点「工作区 → 脚本 → 快剪」",
  })
  print("[快剪] 接收脚本结束")
end

local ok, err = pcall(main)
if not ok then
  print("[快剪] 脚本出错: " .. tostring(err))
end
