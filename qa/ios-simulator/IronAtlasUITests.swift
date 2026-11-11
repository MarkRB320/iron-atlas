import UIKit
import XCTest

final class IronAtlasUITests: XCTestCase {
    @MainActor private lazy var ironAtlas = XCUIApplication(bundleIdentifier: "uk.co.insomniait.ironatlas")

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    override func tearDown() async throws {
        if let run = testRun, run.failureCount > 0 {
            await recordFailure()
        }
        try await super.tearDown()
    }

    @MainActor private func recordFailure() {
        let hierarchy = XCTAttachment(string: ironAtlas.debugDescription)
        hierarchy.name = "failure-accessibility-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "failure-screen"
        shot.lifetime = .keepAlways
        add(shot)
    }

    @MainActor private func buttons(_ label: String, contains: Bool = false) -> XCUIElementQuery {
        let format = contains ? "label CONTAINS[c] %@" : "label ==[c] %@"
        return ironAtlas.webViews.buttons.matching(NSPredicate(format: format, label))
    }

    @MainActor private func text(_ label: String) -> XCUIElement {
        ironAtlas.webViews.descendants(matching: .any)
            .matching(NSPredicate(format: "label ==[c] %@", label)).firstMatch
    }

    @MainActor private func scrollPanel(up: Bool) {
        // Both responsive layouts place the scrollable details panel here.
        let a = ironAtlas.coordinate(withNormalizedOffset: CGVector(dx: 0.76, dy: up ? 0.81 : 0.55))
        let b = ironAtlas.coordinate(withNormalizedOffset: CGVector(dx: 0.76, dy: up ? 0.55 : 0.81))
        a.press(forDuration: 0.08, thenDragTo: b)
    }

    @MainActor private func tap(_ label: String, contains: Bool = false, last: Bool = false,
                     file: StaticString = #filePath, line: UInt = #line) {
        let query = buttons(label, contains: contains)
        // WebKit exposes an offscreen control differently across iOS versions.
        // Try the native accessibility action first, then scroll the details panel.
        let deadline = Date().addingTimeInterval(8)
        while query.count == 0 && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        }
        for attempt in 0..<16 {
            let matches = query.allElementsBoundByIndex
            if let candidate = last ? matches.last : matches.first, candidate.exists {
                if candidate.isHittable {
                    candidate.tap()
                    return
                }
                let frame = candidate.frame
                if !frame.isEmpty {
                    scrollPanel(up: frame.midY >= ironAtlas.frame.midY)
                    continue
                }
            }
            if attempt < 15 { scrollPanel(up: true) }
        }
        XCTFail("Could not tap \(label)", file: file, line: line)
    }

    @MainActor private func capture(_ name: String) throws {
        // Keep real physical pixels while explicitly exporting a 24-bit image.
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        let image = XCUIScreen.main.screenshot().image
        let format = UIGraphicsImageRendererFormat()
        format.opaque = true
        format.scale = image.scale
        format.preferredRange = .standard
        let png = UIGraphicsImageRenderer(size: image.size, format: format).pngData { context in
            context.cgContext.setFillColor(UIColor.white.cgColor)
            context.cgContext.fill(CGRect(origin: .zero, size: image.size))
            image.draw(at: .zero)
        }
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name + ".png"
        attachment.lifetime = .keepAlways
        add(attachment)
        // Also keep a named copy in our dedicated runner. Xcode varies its
        // exported attachment filenames between releases.
        let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("IronAtlasQA", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try png.write(to: folder.appendingPathComponent(name + ".png"), options: .atomic)
    }

    @MainActor func testFreeWorkoutPersistsAcrossRelaunch() throws {
        XCUIDevice.shared.orientation = .portrait
        ironAtlas.launchArguments = ["-AppleLanguages", "(en-GB)", "-AppleLocale", "en_GB"]
        ironAtlas.launch()
        XCTAssertTrue(ironAtlas.wait(for: .runningForeground, timeout: 25))
        XCTAssertTrue(buttons("Get started").firstMatch.waitForExistence(timeout: 50))
        tap("Get started")
        for _ in 0..<3 { tap("Continue") }
        tap("Build my plan")
        tap("Continue with the free plan")
        let prompt = buttons("Continue with the free plan").firstMatch
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false OR hittable == false"), object: prompt)
        XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 8), .completed)
        // The 2.6-second completion toast must finish before the store capture.
        RunLoop.current.run(until: Date().addingTimeInterval(3.0))
        try capture("01-muscle-atlas")

        tap("Plans")
        XCTAssertTrue(buttons("Full body foundations", contains: true).firstMatch.waitForExistence(timeout: 12))
        try capture("02-training-plans")
        tap("Full body foundations", contains: true)
        tap("Start workout")
        XCTAssertTrue(text("Goblet squat").waitForExistence(timeout: 15))
        try capture("03-guided-workout")
        tap("Mark set done")
        XCTAssertTrue(buttons("Undo set").firstMatch.waitForExistence(timeout: 8))
        tap("End workout")
        XCTAssertTrue(text("1 set logged").waitForExistence(timeout: 10))

        ironAtlas.terminate()
        ironAtlas.launch()
        XCTAssertTrue(ironAtlas.wait(for: .runningForeground, timeout: 25))
        // The stage can also expose a Balance toggle. Its label is identical,
        // so use Full balance from the home panel if the navigation did not open.
        tap("Balance", last: true)
        if !text("Recent sets").waitForExistence(timeout: 4) {
            tap("Muscles")
            tap("Full balance")
        }
        let saved = buttons("Delete this set")
        for _ in 0..<20 {
            if saved.count > 0 { break }
            scrollPanel(up: true)
        }
        XCTAssertEqual(saved.count, 1, "Expected exactly the one real logged set on this new simulator")
        XCTAssertTrue(text("Goblet squat").exists, "The saved exercise should be present in recent sets")
    }
}
