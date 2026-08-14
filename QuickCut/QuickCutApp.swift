import SwiftUI
import Foundation
import Darwin

@main
struct QuickCutApp: App {
    init() {
        let args = CommandLine.arguments
        if let index = args.firstIndex(of: "--render-caption-manifest"),
           args.count > index + 2 {
            let code = QuickCutCaptionRasterizer.renderManifest(
                manifestPath: args[index + 1],
                resultPath: args[index + 2]
            )
            exit(code)
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .windowStyle(.titleBar)
        .defaultSize(width: 1600, height: 980)
        .windowResizability(.contentMinSize)
    }
}
