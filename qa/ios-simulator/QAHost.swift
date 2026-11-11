import SwiftUI

// XCTest uses this target for its runner. The test explicitly launches the separately installed Iron Atlas app.
@main
struct SimulatorQAHost: App {
    var body: some Scene {
        WindowGroup { Text("Simulator QA host") }
    }
}
