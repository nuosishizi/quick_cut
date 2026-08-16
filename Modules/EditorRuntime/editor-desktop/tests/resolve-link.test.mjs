import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildResolveSendJob,
  bundledResolveScriptPath,
  bundledTitleSettingPath,
  RESOLVE_TITLE_SETTING,
  fusionCenter,
  fusionFontStyle,
  fusionGlow,
  fusionShadow,
  fusionStroke,
  fusionTextSize,
  hexToCss,
  hexToUnitRgb,
  installResolveLink,
  pickResolveFont,
  resolveLinkStatus,
  resolveScriptDirectories,
  resolveSendProgress,
  sampleHasCjk,
  writeResolveProgress,
} from "../src/resolve-link.mjs";
const scriptPath = bundledResolveScriptPath();
const lua = fs.readFileSync(scriptPath, "utf8");

test("bundled Resolve script has AutoSubs dynamic template engine and text fallback", () => {
  assert.equal(fs.existsSync(scriptPath), true);
  assert.match(lua, /快剪 QuickCut/);
  assert.match(lua, /Copyright \(c\) 2026 HX/);
  assert.match(lua, /AutoSubs Caption/);
  assert.match(lua, /QUICKCUT_CAPTION_DISPLAY_NAME = "快剪字幕"/);
  assert.match(lua, /adopt_quickcut_template_name/);
  assert.match(lua, /AppendToTimeline/);
  assert.match(lua, /WordTiming/);
  assert.match(lua, /CharacterLevelStyling/);
  assert.match(lua, /ImportFolderFromFile/);
  assert.match(lua, /caption-bin\.drb/);
  assert.match(lua, /InsertFusionTitleIntoTimeline/);
  assert.match(lua, /StyledText/);
  assert.match(lua, /job\.json/);
  assert.match(lua, /rawget\(_G, name\)/);
  assert.match(lua, /env_global\("resolve"\)/);
  assert.match(lua, /write_progress/);
  assert.match(lua, /notify_user/);
  assert.match(lua, /快剪已连接达芬奇/);
  assert.match(lua, /apply_autosubs_sentence_background/);
  assert.match(lua, /Enabled4/);
  assert.match(lua, /fnApplyWordTiming\(comp, autosubsTool, wordTiming\)[\s\S]*apply_quickcut_caption_look/);
});

test("font and color mapping stay readable in Fusion", () => {
  assert.deepEqual(hexToUnitRgb("#ffd21f"), [1, 210 / 255, 31 / 255]);
  assert.equal(sampleHasCjk("达芬奇字幕"), true);
  assert.equal(sampleHasCjk("hello"), false);
  assert.equal(pickResolveFont("Helvetica", "你好世界", "win32"), "Microsoft YaHei");
  assert.equal(pickResolveFont("Helvetica", "hello", "win32"), "Arial");
  assert.equal(pickResolveFont("Helvetica", "hello", "darwin"), "Helvetica");
  assert.ok(fusionTextSize(58, { width: 1080, height: 1920 }) > 0.045 && fusionTextSize(58, { width: 1080, height: 1920 }) < 0.08);
  assert.ok(fusionStroke(3, 58) > 0);
  const shadow = fusionShadow({ shadow: 3, shadowBlur: 4, shadowDistance: 3, fontSize: 58, shadowOpacity: 0.8, shadowAngle: 45 });
  assert.equal(shadow.enabled, true);
  assert.ok(shadow.opacity > 0.5);
  assert.equal(fusionFontStyle({ fontWeight: 800, fontItalic: true }), "Bold Italic");
  assert.equal(fusionGlow({ glow: 16, fontSize: 58 }).enabled, true);
  assert.equal(hexToCss("#ffd21f"), "#FFD21F");
  const lowerThird = fusionCenter({ x: 0, y: 538 }, { width: 1080, height: 1920 });
  assert.ok(Math.abs(lowerThird.centerX - 0.5) < 0.001);
  assert.ok(lowerThird.centerY > 0.2 && lowerThird.centerY < 0.3);
});

test("send job wraps captions, generates word timestamps and presetSettings", () => {
  const job = buildResolveSendJob({
    width: 1080,
    height: 1920,
    fps: 30,
    captionStyle: {
      fontFamily: "Helvetica",
      fontSize: 58,
      fontWeight: 800,
      color: "#ffffff",
      stroke: 3,
      strokeColor: "#000000",
      shadow: 3,
      shadowColor: "#000000",
      highlightColor: "#ffd200",
      highlightEnabled: true,
      animation: "pop-in",
    },
    captionTransform: { x: 0, y: 538, width: 860, scale: 1 },
    captions: [
      { text: "第一句字幕内容够长就会换行", start: 1.2, end: 3.4 },
      { text: "  ", start: 4, end: 5 },
    ],
  });
  assert.equal(job.items.length, 1);
  assert.match(job.items[0].text, /第一句/);
  assert.equal(job.items[0].start, 1.2);
  assert.equal(job.style.fontFamily, "Microsoft YaHei");
  assert.equal(job.style.fontStyle, "Bold");
  assert.equal(job.style.strokeEnabled, true);
  assert.equal(job.style.shadowEnabled, true);
  assert.equal(job.style.align, 1);
  assert.equal(job.style.highlightEnabled, true);
  assert.ok(Array.isArray(job.items[0].words));
  assert.ok(job.items[0].words.length >= 1);
  assert.ok(job.presetSettings !== undefined);
  assert.equal(job.presetSettings.PopInEnabled, 1);
  assert.equal(job.presetSettings.HighlightEnabled, 1);
  assert.equal(job.presetSettings.AnimationLevel, 0);
  assert.equal(job.presetSettings.AnimationLength, 0);
  assert.equal(job.presetSettings.BubbleEnabled, 0);
  assert.equal(job.templateName, "快剪字幕");
});

test("send job preserves explicit words timestamps and builds dynamic animation settings", () => {
  const job = buildResolveSendJob({
    width: 1080,
    height: 1920,
    fps: 30,
    captionStyle: {
      fontFamily: "Helvetica",
      fontSize: 58,
      fontWeight: 800,
      color: "#ffffff",
      highlightColor: "#ffd21f",
      highlightEnabled: true,
      stroke: 3,
      shadow: 3,
      animation: "fade",
    },
    captionTransform: { x: 0, y: 538, width: 860, scale: 1 },
    captions: [
      {
        text: "doesn't it feel",
        start: 0,
        end: 1.2,
        words: [
          { display: "doesn't", start: 0, end: 0.4 },
          { display: "it", start: 0.4, end: 0.7 },
          { display: "feel", start: 0.7, end: 1.2 },
        ],
      },
    ],
  });
  assert.equal(job.items.length, 1);
  assert.equal(job.items[0].text, "doesn't it feel");
  assert.equal(job.items[0].words.length, 3);
  assert.equal(job.items[0].words[0].word, "doesn't");
  assert.equal(job.items[0].words[0].start, 0);
  assert.equal(job.items[0].words[0].end, 0.4);
  assert.equal(job.style.highlightEnabled, true);
  assert.equal(job.presetSettings.FadeEnabled, 1);
  assert.equal(job.presetSettings.PopInEnabled, 0);
});

test("send job maps sentence background onto Element 4 Border Fill, not a missing Element 5", () => {
  const job = buildResolveSendJob({
    width: 1080,
    height: 1920,
    fps: 30,
    captionStyle: {
      fontFamily: "Helvetica",
      fontSize: 58,
      color: "#ffffff",
      backgroundEnabled: true,
      background: "#111111",
      backgroundOpacity: 0.8,
      backgroundMode: "line",
      backgroundWidth: 18,
      backgroundHeight: 12,
      backgroundRadius: 10,
    },
    captionTransform: { x: 0, y: 538, width: 860, scale: 1 },
    captions: [{ text: "一句带背景的字幕", start: 0, end: 1.2 }],
  });
  assert.equal(job.style.backgroundEnabled, true);
  assert.equal(job.style.backgroundMode, "line");
  assert.ok(job.style.backgroundOpacity > 0);
  assert.ok(Array.isArray(job.style.backgroundColor));
  assert.equal(job.presetSettings.BubbleEnabled, 0);
  assert.equal(job.templateName, "快剪字幕");
  assert.match(lua, /SetInput Enabled5 is a no-op/);
  assert.match(lua, /useAutosubs = not style.backgroundEnabled/);
  assert.match(lua, /Using 快剪Text\+ generator via AppendToTimeline/);
  assert.match(lua, /find_named_pool_clip/);
  assert.match(lua, /\["快剪Text\+"\] = true/);
  assert.match(lua, /apply_text_outline/);
  assert.match(lua, /pick_quickcut_text_tool/);
  assert.match(lua, /style_plain_text_item/);
  assert.match(lua, /ensure_plain_text_plus/);
  assert.match(lua, /ensure_text_cls/);
  assert.match(lua, /快剪Text/);
  assert.match(lua, /set_number\(tool, "Enabled4", 1\)/);
  assert.match(lua, /apply_sentence_plate/);
  assert.match(lua, /set_number\(tool, "Type4", 1\)/);
  assert.match(lua, /set_number\(tool, "Level4", bgLevel\)/);
  assert.match(lua, /Only the spoken word goes into CLS/);
  assert.match(lua, /harden_text_opacity/);
  assert.match(lua, /apply_quickcut_caption_look/);
  assert.match(
    lua,
    /style_plain_text_item[\s\S]*apply_native_cls_keyframes\(comp, cls, caption, plainText, fps, style\)/,
  );
  assert.match(lua, /StyledTextCLS/);
  assert.match(lua, /SetKeyFrames\(keyframes, true\)/);
  assert.equal(fs.existsSync(bundledTitleSettingPath()), true);
  assert.match(fs.readFileSync(bundledTitleSettingPath(), "utf8"), /TextPlus/);
  assert.match(fs.readFileSync(bundledTitleSettingPath(), "utf8"), /Enabled2 = Input \{ Value = 1/);
  assert.match(fs.readFileSync(bundledTitleSettingPath(), "utf8"), /Type4 = Input \{ Value = 1/);
  assert.equal(job.titleSettingPath, bundledTitleSettingPath());
});

test("word-pill highlight keeps AutoSubs Bubble on Element 4", () => {
  const job = buildResolveSendJob({
    width: 1080,
    height: 1920,
    fps: 30,
    captionStyle: {
      fontFamily: "Helvetica",
      fontSize: 58,
      color: "#ffffff",
      backgroundEnabled: true,
      background: "#111111",
      animation: "word-pill",
    },
    captionTransform: { x: 0, y: 538, width: 860, scale: 1 },
    captions: [{ text: "word pill", start: 0, end: 1 }],
  });
  assert.equal(job.presetSettings.HighlightStyle, 3);
  assert.equal(job.presetSettings.BubbleEnabled, 1);
  assert.equal(job.style.backgroundEnabled, true);
});

test("xiaohongshu gold plate keeps black fill and white word highlight", () => {
  const job = buildResolveSendJob({
    width: 1080,
    height: 1920,
    fps: 30,
    captionStyle: {
      fontFamily: "Helvetica",
      fontSize: 54,
      fontWeight: 800,
      color: "#1c1c1e",
      highlight: "#ffffff",
      highlightEnabled: true,
      backgroundEnabled: true,
      background: "#f6d365",
      backgroundOpacity: 0.96,
      backgroundMode: "block",
      backgroundWidth: 24,
      backgroundHeight: 14,
      radius: 20,
      animation: "karaoke",
    },
    captionTransform: { x: 0, y: 538, width: 860, scale: 1 },
    captions: [{ text: "Not just a weakness.", start: 0, end: 1.6 }],
  });
  assert.equal(job.style.backgroundEnabled, true);
  assert.ok(job.style.backgroundColor[0] > 0.9);
  assert.ok(job.style.backgroundColor[1] > 0.75);
  assert.ok(job.style.color[0] < 0.15);
  assert.ok(job.style.color[1] < 0.15);
  assert.ok(job.style.highlightColor[0] > 0.95);
  assert.ok(job.style.highlightColor[1] > 0.95);
  assert.equal(job.presetSettings.FillColorRed, job.style.color[0]);
  assert.equal(job.presetSettings.HighlightColorRed, job.style.highlightColor[0]);
  assert.equal(job.presetSettings.BubbleEnabled, 0);
  assert.equal(job.presetSettings.HighlightStyle, 0);
  assert.equal(job.presetSettings.FadeEnabled, 0);
  assert.equal(job.style.backgroundRound, 1);
});

test("install writes the script and caption-bin.drb into Resolve Utility folders", () => {
  const previous = process.env.QUICKCUT_SUPPORT_ROOT;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quickcut-resolve-"));
  process.env.QUICKCUT_SUPPORT_ROOT = temp;
  const scriptDir = path.join(temp, "Utility");
  try {
    fs.mkdirSync(scriptDir, { recursive: true });
    const result = installResolveLink({ directories: [scriptDir] });
    assert.equal(fs.existsSync(result.installed), true);
    assert.equal(fs.existsSync(path.join(scriptDir, "caption-bin.drb")), true);
    const packXml = path.join(
      path.dirname(bundledResolveScriptPath()),
      "caption-bin-src",
      "pack",
      "MediaPool",
      "Master",
      "000_QuickCut",
      "MpFolder.xml",
    );
    assert.match(fs.readFileSync(packXml, "utf8"), /<Name>快剪Text\+<\/Name>/);
    assert.equal(fs.existsSync(path.join(scriptDir, RESOLVE_TITLE_SETTING)), true);
    const titleDir = path.join(temp, "Titles");
    installResolveLink({ directories: [scriptDir], titleDirectories: [titleDir] });
    assert.equal(fs.existsSync(path.join(titleDir, RESOLVE_TITLE_SETTING)), true);
    assert.match(fs.readFileSync(result.installed, "utf8"), /工作区/);
    const status = resolveLinkStatus({ directories: [scriptDir] });
    assert.equal(status.installed, true);
    assert.equal(status.listening, false);
    assert.ok(resolveScriptDirectories().length >= 1);
    writeResolveProgress({
      phase: "writing",
      message: "正在写入第 2 / 10 条字幕",
      done: 2,
      total: 10,
      jobId: "qc-test",
    });
    const progress = resolveSendProgress({ directories: [scriptDir] });
    assert.equal(progress.phase, "writing");
    assert.equal(progress.done, 2);
    assert.equal(progress.total, 10);
    assert.equal(progress.percent, 20);
    assert.match(progress.message, /写入/);
    assert.equal(typeof progress.logPath, "string");
  } finally {
    process.env.QUICKCUT_SUPPORT_ROOT = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
