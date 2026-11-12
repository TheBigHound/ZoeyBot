import AppKit
import Foundation

let info = Bundle.main.infoDictionary ?? [:]
guard let launcher = info["BHLauncherPath"] as? String,
      let root = info["BHRoot"] as? String else {
    fputs("ZoeyBot bundle is missing its installation paths. Reinstall it.\n", stderr)
    exit(1)
}

// This mode validates the real executable without opening UI or starting anything.
if CommandLine.arguments.contains("--self-test") {
    let data = try JSONSerialization.data(withJSONObject: [
        "launcher": launcher, "root": root, "action": "start --open-browser"
    ], options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    exit(0)
}

final class LauncherDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?
    let root: String
    let launcher: String

    init(root: String, launcher: String) {
        self.root = root
        self.launcher = launcher
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 130),
                             styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "ZoeyBot"
        let label = NSTextField(labelWithString: "Starting ZoeyBot…")
        label.font = .systemFont(ofSize: 17, weight: .semibold)
        label.frame = NSRect(x: 74, y: 71, width: 310, height: 27)
        let detail = NSTextField(wrappingLabelWithString: "Checking the local VM and services.\nYour browser opens when everything is ready.")
        detail.frame = NSRect(x: 74, y: 22, width: 320, height: 44)
        detail.textColor = .secondaryLabelColor
        let spinner = NSProgressIndicator(frame: NSRect(x: 25, y: 68, width: 28, height: 28))
        spinner.style = .spinning
        spinner.startAnimation(nil)
        panel.contentView?.addSubview(label)
        panel.contentView?.addSubview(detail)
        panel.contentView?.addSubview(spinner)
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window = panel

        let root = self.root
        let launcher = self.launcher
        DispatchQueue.global(qos: .userInitiated).async {
            var failure: String?
            do {
                let logPath = root + "/data/logs/launcher.log"
                let fileManager = FileManager.default
                try fileManager.createDirectory(atPath: root + "/data/logs", withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
                if let attributes = try? fileManager.attributesOfItem(atPath: logPath),
                   attributes[.type] as? FileAttributeType == .typeSymbolicLink {
                    throw NSError(domain: "ZoeyBot", code: 1, userInfo: [NSLocalizedDescriptionKey: "Refusing a symlink launcher log."])
                }
                if !fileManager.fileExists(atPath: logPath) {
                    guard fileManager.createFile(atPath: logPath, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                        throw NSError(domain: "ZoeyBot", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot create private launcher log."])
                    }
                }
                try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logPath)
                let output = try FileHandle(forWritingTo: URL(fileURLWithPath: logPath))
                defer { try? output.close() }
                try output.seekToEnd()
                try output.write(contentsOf: "\n--- ZoeyBot launch \(ISO8601DateFormatter().string(from: Date())) ---\n".data(using: .utf8)!)
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
                process.arguments = [launcher, "start", "--open-browser"]
                process.currentDirectoryURL = URL(fileURLWithPath: root)
                process.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
                process.standardInput = FileHandle.nullDevice
                process.standardOutput = output
                process.standardError = output
                try process.run()
                process.waitUntilExit()
                if process.terminationStatus != 0 {
                    failure = "Startup failed (exit \(process.terminationStatus)).\n\nSee \(logPath) and the component logs in data/logs. No unrelated services were stopped."
                }
            } catch {
                failure = error.localizedDescription
            }
            let errorMessage = failure
            DispatchQueue.main.async {
                self.window?.orderOut(nil)
                if let message = errorMessage {
                    let alert = NSAlert()
                    alert.messageText = "ZoeyBot could not start"
                    alert.informativeText = message
                    alert.alertStyle = .warning
                    alert.addButton(withTitle: "OK")
                    alert.addButton(withTitle: "Show Logs")
                    if alert.runModal() == .alertSecondButtonReturn {
                        NSWorkspace.shared.open(URL(fileURLWithPath: root + "/data/logs"))
                    }
                }
                NSApp.terminate(nil)
            }
        }
    }
}

let app = NSApplication.shared
let delegate = LauncherDelegate(root: root, launcher: launcher)
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
