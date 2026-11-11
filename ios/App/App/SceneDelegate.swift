import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        do {
            try excludeOfflineRecordsFromBackup()
            window?.rootViewController = CAPBridgeViewController()
        } catch {
            // Leave the workout store unopened when the device cannot protect it.
            let controller = UIViewController()
            controller.view.backgroundColor = .systemBackground
            let label = UILabel()
            label.text = "Iron Atlas could not prepare private storage. Close and reopen the app."
            label.numberOfLines = 0
            label.textAlignment = .center
            label.translatesAutoresizingMaskIntoConstraints = false
            controller.view.addSubview(label)
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: controller.view.layoutMarginsGuide.leadingAnchor),
                label.trailingAnchor.constraint(equalTo: controller.view.layoutMarginsGuide.trailingAnchor),
                label.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor)
            ])
            window?.rootViewController = controller
        }
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    // Local storage and IndexedDB contain workout logs, measurements and private photos.
    private func excludeOfflineRecordsFromBackup() throws {
        let files = FileManager.default
        let library = try files.url(for: .libraryDirectory, in: .userDomainMask,
                                    appropriateFor: nil, create: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        for name in ["WebKit", "Application Support"] {
            var directory = library.appendingPathComponent(name, isDirectory: true)
            try files.createDirectory(at: directory, withIntermediateDirectories: true)
            try directory.setResourceValues(values)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
