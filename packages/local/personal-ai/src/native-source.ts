/**
 * Source of `kf-native`, the small macOS helper the Life OS layer compiles on
 * first use (`swiftc`, Command Line Tools). Each subcommand prints one JSON
 * value; `watch` prints one JSON line per interval. It reads only what its
 * subcommand names and never sends anything off the machine.
 */
export const KF_NATIVE_SOURCE = String.raw`
import AppKit
import CryptoKit
import Foundation
import PDFKit
import SQLite3

func emit(_ value: Any) {
  if let data = try? JSONSerialization.data(withJSONObject: value, options: []),
     let text = String(data: data, encoding: .utf8) {
    FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
  }
}

func fail(_ message: String) -> Never {
  emit(["error": message])
  exit(1)
}

func idleSeconds() -> Double {
  let any = CGEventType(rawValue: UInt32.max)!
  return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
}

func frontWindow() -> [String: Any] {
  var out: [String: Any] = [:]
  guard let app = NSWorkspace.shared.frontmostApplication else { return out }
  out["app"] = app.localizedName ?? ""
  out["bundleId"] = app.bundleIdentifier ?? ""
  let pid = app.processIdentifier
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  if let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] {
    for window in list {
      let owner = window[kCGWindowOwnerPID as String] as? Int32 ?? -1
      let layer = window[kCGWindowLayer as String] as? Int ?? -1
      if owner == pid && layer == 0 {
        if let name = window[kCGWindowName as String] as? String, !name.isEmpty { out["title"] = name }
        break
      }
    }
  }
  return out
}

func watch(interval: Double, clipboard: Bool) {
  var lastCount = NSPasteboard.general.changeCount
  setvbuf(stdout, nil, _IOLBF, 0)
  while true {
    var line = frontWindow()
    line["idle"] = idleSeconds()
    if clipboard {
      let count = NSPasteboard.general.changeCount
      if count != lastCount {
        lastCount = count
        if let text = NSPasteboard.general.string(forType: .string) {
          line["clipboard"] = String(text.prefix(20000))
        }
      }
    }
    emit(line)
    Thread.sleep(forTimeInterval: interval)
  }
}

func pdfText(_ path: String) {
  guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { fail("cannot open PDF") }
  var text = ""
  let pages = min(doc.pageCount, 400)
  for index in 0..<pages {
    if let page = doc.page(at: index), let content = page.string { text += content + "\n" }
    if text.count > 2_000_000 { break }
  }
  emit(["text": text, "pages": doc.pageCount])
}

func readStdin() -> Data {
  return FileHandle.standardInput.readDataToEndOfFile()
}

let info = "kairoforge-vault-v1".data(using: .utf8)!

func seCreate(_ keyPath: String) {
  guard SecureEnclave.isAvailable else { fail("secure enclave unavailable") }
  do {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey()
    try key.dataRepresentation.write(to: URL(fileURLWithPath: keyPath), options: .atomic)
    emit(["ok": true])
  } catch { fail("secure enclave key: \(error)") }
}

func seWrap(_ keyPath: String) {
  do {
    let blob = try Data(contentsOf: URL(fileURLWithPath: keyPath))
    let device = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob)
    guard let secret = Data(base64Encoded: String(data: readStdin(), encoding: .utf8)!
      .trimmingCharacters(in: .whitespacesAndNewlines)) else { fail("bad input") }
    let ephemeral = P256.KeyAgreement.PrivateKey()
    let shared = try ephemeral.sharedSecretFromKeyAgreement(with: device.publicKey)
    let wrapKey = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: info, outputByteCount: 32)
    let sealed = try AES.GCM.seal(secret, using: wrapKey)
    let out = ephemeral.publicKey.rawRepresentation + sealed.combined!
    emit(["wrapped": out.base64EncodedString()])
  } catch { fail("wrap: \(error)") }
}

func seUnwrap(_ keyPath: String) {
  do {
    let blob = try Data(contentsOf: URL(fileURLWithPath: keyPath))
    let device = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob)
    guard let input = Data(base64Encoded: String(data: readStdin(), encoding: .utf8)!
      .trimmingCharacters(in: .whitespacesAndNewlines)), input.count > 64 else { fail("bad input") }
    let publicKey = try P256.KeyAgreement.PublicKey(rawRepresentation: input.prefix(64))
    let shared = try device.sharedSecretFromKeyAgreement(with: publicKey)
    let wrapKey = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: info, outputByteCount: 32)
    let box = try AES.GCM.SealedBox(combined: input.dropFirst(64))
    let secret = try AES.GCM.open(box, using: wrapKey)
    emit(["secret": secret.base64EncodedString()])
  } catch { fail("unwrap: \(error)") }
}

func notifications(since: Double) {
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  let candidates = [
    home + "/Library/Group Containers/group.com.apple.usernoted/db2/db",
    NSTemporaryDirectory() + "../0/com.apple.notificationcenter/db2/db",
  ]
  guard let path = candidates.first(where: { FileManager.default.isReadableFile(atPath: $0) }) else {
    fail("notification database not readable (grant Full Disk Access to the app running KairoForge)")
  }
  var db: OpaquePointer?
  guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { fail("cannot open notification database") }
  defer { sqlite3_close(db) }
  let sql = "SELECT r.delivered_date, a.identifier, r.data FROM record r JOIN app a ON a.app_id = r.app_id "
    + "WHERE r.delivered_date > ? ORDER BY r.delivered_date ASC LIMIT 200"
  var statement: OpaquePointer?
  guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { fail("unexpected notification database layout") }
  defer { sqlite3_finalize(statement) }
  sqlite3_bind_double(statement, 1, since - 978307200)
  var rows: [[String: Any]] = []
  while sqlite3_step(statement) == SQLITE_ROW {
    let delivered = sqlite3_column_double(statement, 0) + 978307200
    let app = sqlite3_column_text(statement, 1).map { String(cString: $0) } ?? ""
    var row: [String: Any] = ["at": delivered, "app": app]
    if let bytes = sqlite3_column_blob(statement, 2) {
      let data = Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 2)))
      if let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
         let req = plist["req"] as? [String: Any] {
        row["title"] = req["titl"] as? String ?? ""
        row["subtitle"] = req["subt"] as? String ?? ""
        row["body"] = req["body"] as? String ?? ""
      }
    }
    rows.append(row)
  }
  emit(["notifications": rows])
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: kf-native <command>") }
switch args[1] {
case "idle": emit(["idle": idleSeconds()])
case "front": emit(frontWindow())
case "watch":
  let interval = args.count > 2 ? Double(args[2]) ?? 2 : 2
  watch(interval: max(0.5, interval), clipboard: args.contains("--clipboard"))
case "pdf-text": if args.count > 2 { pdfText(args[2]) } else { fail("pdf-text <path>") }
case "se-available": emit(["available": SecureEnclave.isAvailable])
case "se-create": if args.count > 2 { seCreate(args[2]) } else { fail("se-create <keyfile>") }
case "se-wrap": if args.count > 2 { seWrap(args[2]) } else { fail("se-wrap <keyfile>") }
case "se-unwrap": if args.count > 2 { seUnwrap(args[2]) } else { fail("se-unwrap <keyfile>") }
case "notifications": notifications(since: args.count > 2 ? Double(args[2]) ?? 0 : 0)
default: fail("unknown command")
}
`
