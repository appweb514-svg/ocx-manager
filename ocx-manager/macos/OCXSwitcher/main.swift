import AppKit
import Foundation

// ---------------------------------------------------------------------------
// OCX Switcher — menu bar macOS pour basculer provider/modèle opencodex
// ---------------------------------------------------------------------------

private let managerURL = URL(string: "http://127.0.0.1:10105")!
/// Chemin du serveur OCX Manager, calculé par rapport au bundle
/// (OCXSwitcher.app → macos → ocx-manager/server.mjs) pour être portable.
private let serverPath: String = {
  let bundle = Bundle.main.bundleURL
  return bundle
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("server.mjs")
    .path
}()

// MARK: - Modèles de données (miroir de /local/state)

private struct Provider: Decodable {
  let name: String
  let disabled: Bool?
  let hasApiKey: Bool?
  let defaultModel: String?
}

private struct SelectedModels: Decodable {
  let selected: [String: [String]]?
  let available: [String: [String]]?
}

private struct OcxConfig: Decodable {
  let defaultProvider: String?
}

private struct AppState: Decodable {
  let health: Health?
  let providers: [Provider]?
  let selectedModels: SelectedModels?
  let models: [ModelRow]?
  let config: OcxConfig?
  let activeModel: String?

  struct Health: Decodable {
    let status: String?
    let version: String?
    let port: Int?
  }
}

private struct ModelRow: Decodable {
  let id: String
  let provider: String
  let disabled: Bool?
}

private struct PresetProviderConfig: Decodable {
  let adapter: String?
  let baseUrl: String?
  let authMode: String?
  let defaultModel: String?
}

private struct ProviderPreset: Decodable {
  let id: String
  let label: String
  let adapter: String?
  let baseUrl: String?
  let auth: String?
  let defaultModel: String?
  let oauthProvider: String?
  let note: String?
  let provider: PresetProviderConfig?
}

// MARK: - AppDelegate

private final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private var cachedState: AppState?
  private var rebuilding = false
  private var addController: AddProviderController?
  private var modelsController: ModelVisibilityController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    installEditMenu()
    if let button = statusItem.button {
      if let image = NSImage(systemSymbolName: "bolt.circle.fill", accessibilityDescription: "OCX Switcher") {
        image.isTemplate = true
        button.image = image
      } else {
        button.title = "ocx"
      }
    }
    let menu = NSMenu()
    menu.delegate = self
    menu.autoenablesItems = false
    statusItem.menu = menu
    rebuildMenu()

    // Rafraîchissement périodique (état du titre / infobulle)
    Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
      self?.cachedState = Self.fetchState()
      self?.statusItem.button?.toolTip = self?.statusTooltip()
    }
  }

  /// Les apps menu-bar (LSUIElement) n'ont pas de menu Édition : Cmd+V/C/X/A ne sont
  /// jamais routés vers les champs de texte. On installe le menu standard pour que
  /// le copier-coller fonctionne partout.
  private func installEditMenu() {
    let mainMenu = NSMenu()

    let appMenuItem = NSMenuItem()
    mainMenu.addItem(appMenuItem)
    let appMenu = NSMenu(title: "OCX Switcher")
    appMenuItem.submenu = appMenu
    appMenu.addItem(withTitle: "Quitter OCX Switcher", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

    let editMenuItem = NSMenuItem()
    mainMenu.addItem(editMenuItem)
    let editMenu = NSMenu(title: "Édition")
    editMenuItem.submenu = editMenu
    editMenu.addItem(withTitle: "Annuler", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Rétablir", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(NSMenuItem.separator())
    editMenu.addItem(withTitle: "Couper", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copier", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Coller", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Tout sélectionner", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

    NSApp.mainMenu = mainMenu
  }

  // MARK: - Fetch

  fileprivate static func fetchState() -> AppState? {
    let semaphore = DispatchSemaphore(value: 0)
    var result: AppState?
    var request = URLRequest(url: managerURL.appendingPathComponent("local/state"))
    request.timeoutInterval = 4
    URLSession.shared.dataTask(with: request) { data, _, _ in
      if let data,
         let state = try? JSONDecoder().decode(AppState.self, from: data) {
        result = state
      }
      semaphore.signal()
    }.resume()
    _ = semaphore.wait(timeout: .now() + 5)
    return result
  }

  private static func switchModel(provider: String, model: String) {
    let slug = model.contains("/") ? model : "\(provider)/\(model)"
    guard let url = managerURL.appendingPathComponent("local/switch") as URL? else { return }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["provider": provider, "model": slug])
    URLSession.shared.dataTask(with: request).resume()
  }

  fileprivate static func apiRequest(_ path: String, method: String, body: [String: Any]? = nil) -> (status: Int, json: [String: Any]?) {
    guard let url = managerURL.appendingPathComponent(path) as URL? else { return (0, nil) }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 7
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    let semaphore = DispatchSemaphore(value: 0)
    var status = 0
    var json: [String: Any]?
    URLSession.shared.dataTask(with: request) { data, response, _ in
      status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if let data { json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] }
      semaphore.signal()
    }.resume()
    _ = semaphore.wait(timeout: .now() + 8)
    return (status, json)
  }

  private static func fetchPresets() -> [ProviderPreset] {
    let result = apiRequest("ocx/provider-presets", method: "GET")
    guard let json = result.json,
          let list = json["providers"] as? [[String: Any]],
          let data = try? JSONSerialization.data(withJSONObject: list) else { return [] }
    return (try? JSONDecoder().decode([ProviderPreset].self, from: data)) ?? []
  }

  // MARK: - Menu

  func menuWillOpen(_ menu: NSMenu) {
    guard !rebuilding else { return }
    rebuildMenu()
  }

  private func rebuildMenu() {
    rebuilding = true
    defer { rebuilding = false }

    cachedState = Self.fetchState()
    let menu = NSMenu()
    menu.delegate = self
    menu.autoenablesItems = false

    guard let state = cachedState else {
      let header = NSMenuItem(title: "OCX Manager injoignable", action: nil, keyEquivalent: "")
      header.isEnabled = false
      menu.addItem(header)
      menu.addItem(NSMenuItem.separator())
      menu.addItem(makeItem("Démarrer le serveur", #selector(startServer), "s"))
      menu.addItem(makeItem("Quitter OCX Switcher", #selector(quitApp), "q"))
      statusItem.menu = menu
      statusItem.button?.toolTip = "OCX Switcher — serveur injoignable"
      return
    }

    let healthOK = state.health?.status == "ok"
    let active = state.activeModel ?? "— aucun modèle —"
    let header = NSMenuItem(title: "Modèle actif : \(active)", action: nil, keyEquivalent: "")
    header.isEnabled = false
    menu.addItem(header)

    if !healthOK {
      let warn = NSMenuItem(title: "⚠ proxy opencodex arrêté", action: nil, keyEquivalent: "")
      warn.isEnabled = false
      menu.addItem(warn)
    }
    menu.addItem(NSMenuItem.separator())

    let providers = (state.providers ?? [])
      .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    let defaultProvider = state.config?.defaultProvider

    for (index, provider) in providers.enumerated() {
      let isDefault = provider.name == defaultProvider
      let title = "\(index + 1) · \(provider.name)\(isDefault ? "  ★" : "")"
      let submenu = NSMenu()
      submenu.autoenablesItems = false

      if provider.disabled == true {
        let item = NSMenuItem(title: "Désactivé", action: nil, keyEquivalent: "")
        item.isEnabled = false
        submenu.addItem(item)
      } else {
        let defaultItem = NSMenuItem(
          title: isDefault ? "Provider par défaut ✓" : "Définir comme provider par défaut",
          action: isDefault ? nil : #selector(setDefaultProvider(_:)),
          keyEquivalent: ""
        )
        defaultItem.target = self
        defaultItem.representedObject = provider.name
        submenu.addItem(defaultItem)
        submenu.addItem(NSMenuItem.separator())

        let providerRows = (state.models ?? []).filter { $0.provider == provider.name }
        let visibleRows = providerRows.filter { $0.disabled != true }
        let hiddenCount = providerRows.count - visibleRows.count
        let models = visibleRows.map(\.id).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        if models.isEmpty {
          let empty = NSMenuItem(title: hiddenCount > 0 ? "tous les modèles sont masqués" : "aucun modèle découvert", action: nil, keyEquivalent: "")
          empty.isEnabled = false
          submenu.addItem(empty)
        } else {
          for model in models {
            let slug = "\(provider.name)/\(model)"
            let item = NSMenuItem(
              title: model,
              action: #selector(switchModelAction(_:)),
              keyEquivalent: ""
            )
            item.target = self
            item.representedObject = ["provider": provider.name, "model": slug]
            item.state = (active == slug || active == model) ? .on : .off
            submenu.addItem(item)
          }
        }
        if hiddenCount > 0 {
          let hidden = NSMenuItem(title: "\(hiddenCount) modèle\(hiddenCount > 1 ? "s" : "") masqué\(hiddenCount > 1 ? "s" : "")", action: nil, keyEquivalent: "")
          hidden.isEnabled = false
          submenu.addItem(hidden)
        }
        submenu.addItem(NSMenuItem.separator())
        let manage = NSMenuItem(title: "👁 Gérer les modèles…", action: #selector(manageModels(_:)), keyEquivalent: "")
        manage.target = self
        manage.representedObject = provider.name
        submenu.addItem(manage)
      }

      let providerItem = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      providerItem.submenu = submenu
      menu.addItem(providerItem)
    }

    menu.addItem(NSMenuItem.separator())
    menu.addItem(makeItem("➕ Ajouter un provider…", #selector(addProviderAction), "+"))
    menu.addItem(NSMenuItem.separator())
    menu.addItem(makeItem("Rafraîchir", #selector(refresh), "r"))
    menu.addItem(makeItem("Ouvrir le tableau de bord", #selector(openDashboard), "o"))
    menu.addItem(makeItem("Quitter OCX Switcher", #selector(quitApp), "q"))

    statusItem.menu = menu
    statusItem.button?.toolTip = statusTooltip()
  }

  private func makeItem(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.target = self
    return item
  }

  private func statusTooltip() -> String {
    guard let state = cachedState else { return "OCX Switcher — serveur injoignable" }
    return "OCX Switcher — \(state.activeModel ?? "aucun modèle")"
  }

  // MARK: - Actions

  @objc private func switchModelAction(_ sender: NSMenuItem) {
    guard let payload = sender.representedObject as? [String: String],
          let provider = payload["provider"],
          let model = payload["model"] else { return }
    Self.switchModel(provider: provider, model: model)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
      self?.rebuildMenu()
    }
  }

  @objc private func setDefaultProvider(_ sender: NSMenuItem) {
    guard let name = sender.representedObject as? String,
          let url = managerURL.appendingPathComponent("ocx/providers") as URL? else { return }
    var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "name", value: name)]
    var request = URLRequest(url: components.url!)
    request.httpMethod = "PATCH"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["setDefault": true])
    URLSession.shared.dataTask(with: request).resume()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
      self?.rebuildMenu()
    }
  }

  @objc private func refresh() {
    rebuildMenu()
  }

  @objc private func addProviderAction() {
    NSApp.activate(ignoringOtherApps: true)
    let controller = AddProviderController(presets: Self.fetchPresets())
    addController = controller
    controller.run { [weak self] in
      self?.addController = nil
      self?.rebuildMenu()
    }
  }

  @objc private func manageModels(_ sender: NSMenuItem) {
    guard let provider = sender.representedObject as? String else { return }
    NSApp.activate(ignoringOtherApps: true)
    let controller = ModelVisibilityController(provider: provider)
    modelsController = controller
    controller.run { [weak self] in
      self?.modelsController = nil
      self?.rebuildMenu()
    }
  }

  @objc private func openDashboard() {
    NSWorkspace.shared.open(URL(string: "http://localhost:10105/")!)
  }

  @objc private func startServer() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", serverPath]
    try? process.run()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
      self?.rebuildMenu()
    }
  }

  @objc private func quitApp() {
    NSApp.terminate(nil)
  }
}

// MARK: - Ajout de provider (panneau avec presets + clé API)

private final class AddProviderController: NSObject {
  private let presets: [ProviderPreset]
  private let presetPopup = NSPopUpButton(frame: .zero, pullsDown: false)
  private let nameField = NSTextField(frame: .zero)
  private let adapterPopup = NSPopUpButton(frame: .zero, pullsDown: false)
  private let baseField = NSTextField(frame: .zero)
  private let keyField = NSTextField(frame: .zero)
  private let modelField = NSTextField(frame: .zero)
  private let defaultCheck = NSButton(checkboxWithTitle: "Définir comme provider par défaut", target: nil, action: nil)
  private let container = NSView(frame: NSRect(x: 0, y: 0, width: 500, height: 600))
  private var panel: NSPanel?
  private var onDone: (() -> Void)?

  init(presets: [ProviderPreset]) {
    self.presets = presets
    super.init()

    let width: CGFloat = 500
    var y: CGFloat = 590

    func place(_ title: String, _ control: NSView, _ height: CGFloat = 32, _ topPad: CGFloat = 0) {
      y += topPad
      y -= 20
      let label = NSTextField(labelWithString: title)
      label.frame = NSRect(x: 0, y: y, width: width, height: 16)
      label.font = NSFont.systemFont(ofSize: 12, weight: .medium)
      label.textColor = .secondaryLabelColor
      container.addSubview(label)
      y -= 8
      control.frame = NSRect(x: 0, y: y - height, width: width, height: height)
      container.addSubview(control)
      y -= height + 8
    }

    place("Preset (remplit les champs)", presetPopup)
    place("Nom  *", nameField)
    place("Adapter  *", adapterPopup)
    place("Base URL  *", baseField)
    place("Clé API", keyField, 64, 24)
    place("Modèle par défaut (optionnel)", modelField)

    y -= 16
    defaultCheck.frame = NSRect(x: 0, y: y, width: width, height: 22)
    container.addSubview(defaultCheck)

    y -= 30
    let hint = NSTextField(labelWithString: "Conseil : cliquez dans le champ Clé API puis Cmd+V pour coller.")
    hint.frame = NSRect(x: 0, y: y, width: width, height: 16)
    hint.font = NSFont.systemFont(ofSize: 11)
    hint.textColor = .tertiaryLabelColor
    container.addSubview(hint)

    let bigFont = NSFont.systemFont(ofSize: 14)
    for field in [nameField, baseField, keyField, modelField] as [NSTextField] {
      field.font = bigFont
    }
    // Champ clé multi-lignes : ~2 lignes visibles, retour à la ligne automatique
    keyField.usesSingleLineMode = false
    keyField.cell?.wraps = true
    keyField.cell?.isScrollable = false
    keyField.maximumNumberOfLines = 2
    keyField.lineBreakMode = .byWordWrapping
    keyField.placeholderString = "Collez votre clé ici (Cmd+V)"
    keyField.toolTip = "Cliquez dans le champ puis Cmd+V pour coller votre clé"
    keyField.focusRingType = .default

    let addButton = NSButton(title: "Ajouter", target: self, action: #selector(addClicked))
    addButton.keyEquivalent = "\r"
    addButton.bezelStyle = .rounded
    addButton.frame = NSRect(x: 500 - 120, y: 16, width: 110, height: 32)
    container.addSubview(addButton)

    let cancelButton = NSButton(title: "Annuler", target: self, action: #selector(cancelClicked))
    cancelButton.keyEquivalent = "\u{1b}"
    cancelButton.bezelStyle = .rounded
    cancelButton.frame = NSRect(x: 500 - 240, y: 16, width: 110, height: 32)
    container.addSubview(cancelButton)

    presetPopup.addItem(withTitle: "— Personnalisé —")
    for preset in presets.sorted(by: { $0.label.localizedStandardCompare($1.label) == .orderedAscending }) {
      presetPopup.addItem(withTitle: preset.label)
      presetPopup.lastItem?.representedObject = preset
    }
    presetPopup.target = self
    presetPopup.action = #selector(presetChanged(_:))
    adapterPopup.addItems(withTitles: ["openai-chat", "openai-responses", "anthropic", "google", "azure-openai", "cursor"])
    defaultCheck.state = .off
  }

  func run(onDone: @escaping () -> Void) {
    self.onDone = onDone
    let panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 500, height: 640),
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    panel.title = "Ajouter un provider"
    panel.contentView = container
    panel.isReleasedWhenClosed = false
    panel.center()
    self.panel = panel

    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
    panel.makeFirstResponder(keyField)
    NSApp.runModal(for: panel)
    panel.orderOut(nil)
  }

  @objc private func cancelClicked() {
    NSApp.stopModal()
    onDone?()
  }

  @objc private func addClicked() {
    submit()
    NSApp.stopModal()
    onDone?()
  }

  @objc private func presetChanged(_ sender: NSPopUpButton) {
    guard let preset = sender.selectedItem?.representedObject as? ProviderPreset else { return }
    nameField.stringValue = preset.id
    adapterPopup.selectItem(withTitle: preset.provider?.adapter ?? preset.adapter ?? "openai-chat")
    baseField.stringValue = preset.provider?.baseUrl ?? preset.baseUrl ?? ""
    modelField.stringValue = preset.provider?.defaultModel ?? preset.defaultModel ?? ""
  }

  private func submit() {
    let name = nameField.stringValue.trimmingCharacters(in: .whitespaces)
    let baseURL = baseField.stringValue.trimmingCharacters(in: .whitespaces)
    guard !name.isEmpty, !baseURL.isEmpty else {
      let alert = NSAlert()
      alert.messageText = "Nom et Base URL sont obligatoires"
      alert.runModal()
      return
    }

    var provider: [String: Any] = [
      "adapter": adapterPopup.titleOfSelectedItem ?? "openai-chat",
      "baseUrl": baseURL,
    ]
    let model = modelField.stringValue.trimmingCharacters(in: .whitespaces)
    if !model.isEmpty { provider["defaultModel"] = model }
    if baseURL.contains("localhost") || baseURL.contains("127.0.0.1") {
      provider["allowPrivateNetwork"] = true
    }

    let payload: [String: Any] = [
      "name": name,
      "provider": provider,
      "setDefault": defaultCheck.state == .on,
    ]
    let r1 = AppDelegate.apiRequest("ocx/providers", method: "POST", body: payload)
    guard r1.status == 200 || r1.status == 201 else {
      let error = (r1.json?["error"] as? String) ?? "HTTP \(r1.status)"
      let alert = NSAlert()
      alert.messageText = "Échec de l'ajout du provider"
      alert.informativeText = error
      alert.runModal()
      return
    }

    let key = keyField.stringValue.trimmingCharacters(in: .whitespaces)
    if !key.isEmpty {
      let r2 = AppDelegate.apiRequest("ocx/providers/keys", method: "POST", body: [
        "name": name,
        "key": key,
        "label": "via OCX Switcher",
      ])
      if r2.status != 200 && r2.status != 201 {
        let error = (r2.json?["error"] as? String) ?? "HTTP \(r2.status)"
        let alert = NSAlert()
        alert.messageText = "Provider ajouté, mais clé non enregistrée"
        alert.informativeText = error
        alert.runModal()
      }
    }

    _ = AppDelegate.apiRequest("ocx/sync", method: "POST", body: [:])

    let selectedPreset = presetPopup.selectedItem?.representedObject as? ProviderPreset
    if selectedPreset?.auth == "oauth" {
      let alert = NSAlert()
      alert.messageText = "Provider « \(name) » ajouté ✓"
      alert.informativeText = "Ce preset utilise OAuth. Lancez ensuite dans un terminal : ocx login \(selectedPreset?.oauthProvider ?? selectedPreset?.id ?? name)"
      alert.runModal()
    }
  }
}

// MARK: - Visibilité des modèles (fenêtre cases à cocher + tout afficher/cacher)

/// Vue à coordonnées inversées pour que la liste démarre en haut du scroll.
private final class FlippedView: NSView {
  override var isFlipped: Bool { true }
}

private final class ModelVisibilityController: NSObject {
  private let provider: String
  private var rows: [ModelRow] = []
  private var checkboxes: [String: NSButton] = [:]
  private let scrollView = NSScrollView(frame: .zero)
  private let summaryLabel = NSTextField(labelWithString: "")
  private let showAllButton = NSButton(title: "👁 Tout afficher", target: nil, action: nil)
  private let hideAllButton = NSButton(title: "🙈 Tout cacher", target: nil, action: nil)
  private let container = NSView(frame: NSRect(x: 0, y: 0, width: 520, height: 540))
  private var panel: NSPanel?
  private var onDone: (() -> Void)?

  init(provider: String) {
    self.provider = provider
    super.init()
    let state = AppDelegate.fetchState()
    rows = (state?.models ?? [])
      .filter { $0.provider == provider }
      .sorted { $0.id.localizedStandardCompare($1.id) == .orderedAscending }
  }

  func run(onDone: @escaping () -> Void) {
    self.onDone = onDone

    // En-tête : résumé + boutons tout afficher / tout cacher
    summaryLabel.frame = NSRect(x: 0, y: 0, width: 200, height: 22)
    summaryLabel.font = NSFont.systemFont(ofSize: 12)
    summaryLabel.textColor = .secondaryLabelColor
    container.addSubview(summaryLabel)

    showAllButton.bezelStyle = .rounded
    showAllButton.target = self
    showAllButton.action = #selector(showAllClicked)
    showAllButton.frame = NSRect(x: 520 - 250, y: 0, width: 120, height: 28)
    container.addSubview(showAllButton)

    hideAllButton.bezelStyle = .rounded
    hideAllButton.target = self
    hideAllButton.action = #selector(hideAllClicked)
    hideAllButton.frame = NSRect(x: 520 - 122, y: 0, width: 118, height: 28)
    container.addSubview(hideAllButton)

    // Liste scrollable des modèles
    let rowHeight: CGFloat = 28
    let doc = FlippedView(frame: NSRect(x: 0, y: 0, width: 490, height: CGFloat(rows.count) * rowHeight + 8))
    for (index, row) in rows.enumerated() {
      let cb = NSButton(checkboxWithTitle: row.id, target: self, action: #selector(visibilityChanged))
      cb.state = row.disabled == true ? .off : .on
      cb.frame = NSRect(x: 8, y: CGFloat(index) * rowHeight + 4, width: 470, height: 22)
      cb.font = NSFont.systemFont(ofSize: 13)
      checkboxes[row.id] = cb
      doc.addSubview(cb)
    }
    scrollView.documentView = doc
    scrollView.hasVerticalScroller = true
    scrollView.autohidesScrollers = true
    scrollView.borderType = .bezelBorder
    scrollView.frame = NSRect(x: 0, y: 38, width: 520, height: 430)
    container.addSubview(scrollView)

    // Boutons bas
    let addButton = NSButton(title: "Enregistrer", target: self, action: #selector(saveClicked))
    addButton.keyEquivalent = "\r"
    addButton.bezelStyle = .rounded
    addButton.frame = NSRect(x: 520 - 120, y: 480, width: 110, height: 32)
    container.addSubview(addButton)

    let cancelButton = NSButton(title: "Annuler", target: self, action: #selector(cancelClicked))
    cancelButton.keyEquivalent = "\u{1b}"
    cancelButton.bezelStyle = .rounded
    cancelButton.frame = NSRect(x: 520 - 240, y: 480, width: 110, height: 32)
    container.addSubview(cancelButton)

    updateSummary()

    let panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 520, height: 540),
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    panel.title = "Modèles — \(provider)"
    panel.contentView = container
    panel.isReleasedWhenClosed = false
    panel.center()
    self.panel = panel

    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
    NSApp.runModal(for: panel)
    panel.orderOut(nil)
  }

  private func updateSummary() {
    let total = rows.count
    let checked = checkboxes.values.filter { $0.state == .on }.count
    summaryLabel.stringValue = total > 0 ? "\(checked) affiché\(checked > 1 ? "s" : "") · \(total - checked) masqué\(total - checked > 1 ? "s" : "")" : "aucun modèle"
    showAllButton.isEnabled = checked < total
    hideAllButton.isEnabled = checked > 0
  }

  @objc private func visibilityChanged() {
    updateSummary()
  }

  @objc private func showAllClicked() {
    for cb in checkboxes.values { cb.state = .on }
    updateSummary()
  }

  @objc private func hideAllClicked() {
    for cb in checkboxes.values { cb.state = .off }
    updateSummary()
  }

  @objc private func cancelClicked() {
    NSApp.stopModal()
    onDone?()
  }

  @objc private func saveClicked() {
    guard !rows.isEmpty else {
      NSApp.stopModal()
      onDone?()
      return
    }
    let visibleIds = Set(checkboxes.filter { $0.value.state == .on }.map(\.key))
    let allIds = rows.map(\.id)
    let hiddenIds = allIds.filter { !visibleIds.contains($0) }

    // 1) Tout réafficher (vider allowlist + blocklist du provider)
    _ = AppDelegate.apiRequest("ocx/model-visibility", method: "PUT", body: [
      "scope": "provider",
      "provider": provider,
      "enabled": true,
      "targets": allIds.map { ["id": $0, "native": false] },
    ])
    // 2) Masquer ceux qui sont décochés
    if !hiddenIds.isEmpty {
      _ = AppDelegate.apiRequest("ocx/model-visibility", method: "PUT", body: [
        "scope": "models",
        "provider": provider,
        "enabled": false,
        "targets": hiddenIds.map { ["id": $0, "native": false] },
      ])
    }
    // 3) Resynchroniser le catalogue Codex
    _ = AppDelegate.apiRequest("ocx/sync", method: "POST", body: [:])

    NSApp.stopModal()
    onDone?()
  }
}

// MARK: - Lancement

let app = NSApplication.shared
private let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
