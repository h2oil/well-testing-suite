import UIKit
import Capacitor

/// UIKit scene life cycle (required for apps built with the iOS 27 SDK: an app without a
/// scene manifest is terminated at launch — Apple TN3187).
///
/// Info.plist → UIApplicationSceneManifest names this class and Main.storyboard, so UIKit
/// creates the window and MainViewController (the Capacitor bridge) itself. This delegate
/// only forwards URL opens and Universal Links to Capacitor, which the App delegate used to
/// receive before scenes, so the App plugin's appUrlOpen / getLaunchUrl keep working.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow? {
        // Keep AppDelegate.window pointing at the scene's window for code that still looks
        // for the window there (plugins written for the pre-scene life cycle).
        didSet { (UIApplication.shared.delegate as? AppDelegate)?.window = window }
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard scene is UIWindowScene else { return }
        (UIApplication.shared.delegate as? AppDelegate)?.window = window
        // Cold start from a link: the URL / activity arrives here, not in the open-URL callbacks.
        if let url = connectionOptions.urlContexts.first?.url {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
        }
        if let activity = connectionOptions.userActivities.first {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }
}
