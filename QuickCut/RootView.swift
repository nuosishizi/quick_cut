import SwiftUI

struct RootView: View {
    @StateObject private var editorModel = EditorHostModel()

    var body: some View {
        EditorLauncherView(model: editorModel)
            .frame(minWidth: 980, minHeight: 680)
            .background(Color(nsColor: .windowBackgroundColor))
            .preferredColorScheme(.dark)
    }
}
