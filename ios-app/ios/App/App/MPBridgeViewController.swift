//
//  MPBridgeViewController.swift — capa nativa sobre el WebView de Capacitor
//
//  QUÉ HACE
//  --------
//  Añade una UITabBar NATIVA de iOS al pie de la app. Al tocar una pestaña no se
//  recarga ninguna página: se llama al router que ya existe en el JS
//  (window.mpIrA), así que la navegación web y la nativa son el mismo estado.
//
//  POR QUÉ
//  -------
//  Un WebView que solo envuelve un sitio es, para Apple, un "lazy wrapper" y se
//  rechaza. La diferencia entre eso y una app aceptable es tener una capa
//  nativa real: barra de pestañas del sistema, transiciones nativas, y la
//  chrome del sistema respondiendo como en cualquier app de iOS. Esto es esa
//  capa, y de paso mejora el uso con el pulgar: la navegación baja al alcance
//  de la mano en vez de vivir arriba, donde estaba la sub-nav web.
//
//  Se subclasea CAPBridgeViewController en vez de meter un contenedor aparte
//  para no tocar el ciclo de vida del bridge (plugins, teclado, safe areas):
//  Capacitor sigue siendo el dueño de su vista, nosotros solo añadimos encima.
//

import UIKit
import WebKit
#if canImport(WidgetKit)
import WidgetKit
#endif
import Capacitor

final class MPBridgeViewController: CAPBridgeViewController, UITabBarDelegate, WKScriptMessageHandler {

    // Debe coincidir con los data-vista del HTML: el JS los usa para enrutar.
    private struct Pestana {
        let vista: String
        let titulo: String
        let icono: String       // SF Symbol
    }

    private let pestanas: [Pestana] = [
        Pestana(vista: "periodico",     titulo: "Periódico",  icono: "newspaper"),
        Pestana(vista: "portafolio",    titulo: "Portafolio", icono: "chart.bar"),
        Pestana(vista: "analizar",      titulo: "Analizar",   icono: "magnifyingglass"),
        Pestana(vista: "transacciones", titulo: "ISR",        icono: "doc.text"),
        Pestana(vista: "cuenta",        titulo: "Cuenta",     icono: "person"),
    ]

    private lazy var tabBar: UITabBar = {
        let b = UITabBar()
        b.translatesAutoresizingMaskIntoConstraints = false
        b.delegate = self
        b.items = pestanas.enumerated().map { i, p in
            let item = UITabBarItem(title: p.titulo,
                                    image: UIImage(systemName: p.icono),
                                    tag: i)
            return item
        }
        b.selectedItem = b.items?.first

        // Tinta y papel: los mismos tokens que mp-tokens.css, para que la barra
        // nativa no se sienta pegada encima de otra app.
        let fondo   = UIColor(red: 0.937, green: 0.945, blue: 0.961, alpha: 1)  // #EFF1F5
        let sello   = UIColor(red: 0.612, green: 0.365, blue: 0.071, alpha: 1)  // #9C5D12
        let tinta3  = UIColor(red: 0.369, green: 0.353, blue: 0.318, alpha: 1)  // #5E5A51
        let regla   = UIColor(red: 0.875, green: 0.859, blue: 0.816, alpha: 1)  // #DFDBD0

        let apar = UITabBarAppearance()
        apar.configureWithOpaqueBackground()
        apar.backgroundColor = fondo
        apar.shadowColor = regla                     // hairline, no sombra difusa
        for layout in [apar.stackedLayoutAppearance,
                       apar.inlineLayoutAppearance,
                       apar.compactInlineLayoutAppearance] {
            layout.normal.iconColor = tinta3
            layout.normal.titleTextAttributes = [
                .foregroundColor: tinta3,
                .font: UIFont.monospacedSystemFont(ofSize: 10, weight: .medium),
            ]
            layout.selected.iconColor = sello
            layout.selected.titleTextAttributes = [
                .foregroundColor: sello,
                .font: UIFont.monospacedSystemFont(ofSize: 10, weight: .semibold),
            ]
        }
        b.standardAppearance = apar
        b.scrollEdgeAppearance = apar
        return b
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        inyectarMarcaNativa()
        view.addSubview(tabBar)
        NSLayoutConstraint.activate([
            tabBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tabBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tabBar.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        // Le avisamos al lado web que hay barra nativa para que esconda su
        // sub-nav y deje hueco al pie. Si el JS aún no cargó, viewDidAppear
        // vuelve a intentarlo.
        anunciarModoNativo()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        anunciarModoNativo()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // El WebView no debe quedar debajo de la barra: se le mete inset por
        // abajo en vez de encogerlo, así el scroll llega hasta el final.
        guard let wv = webView else { return }
        let alto = tabBar.isHidden ? 0 : tabBar.frame.height
        if wv.scrollView.contentInset.bottom != alto {
            wv.scrollView.contentInset.bottom = alto
            wv.scrollView.verticalScrollIndicatorInsets.bottom = alto
        }
    }

    // MARK: - Puente con el JS

    /// Canal desde el JS hacia Swift para el bloqueo biométrico. Se registra
    /// una sola vez; el nombre debe coincidir con el que usa `window.mpBloqueo`.
    private func registrarCanalBloqueo() {
        guard let wv = webView else { return }
        let cc = wv.configuration.userContentController
        for canal in ["mpBloqueo", "mpUI", "mpWidget"] {
            cc.removeScriptMessageHandler(forName: canal)
            cc.add(self, name: canal)
        }
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let cuerpo = message.body as? [String: Any],
              let accion = cuerpo["accion"] as? String else { return }

        switch message.name {
        case "mpBloqueo":
            switch accion {
            case "activar":
                MPBloqueoBiometrico.shared.activado = (cuerpo["valor"] as? Bool) ?? false
            case "estado":
                let activo = MPBloqueoBiometrico.shared.activado
                let tipo = MPBloqueoBiometrico.shared.tipoDisponible
                evaluar("window.mpBloqueoEstado && window.mpBloqueoEstado({activo: \(activo), tipo: '\(tipo)'});")
            default: break
            }

        case "mpWidget":
            // La web manda la lista que el usuario editó en Analizar. Se copia
            // al App Group, que es lo único que el widget —proceso aparte— sabe
            // leer, y se le pide a WidgetKit que recargue en el acto.
            if accion == "guardar", let t = cuerpo["tickers"] as? [String] {
                MPWidgetConfig.guardar(t)
            }

        case "mpUI":
            // La web avisa cuando abre o cierra una capa a pantalla completa
            // (tour, paywall, gate de cuenta). Sin esto la barra nativa flota
            // ENCIMA del modal y tapa sus botones.
            if accion == "tabbar" {
                let visible = (cuerpo["visible"] as? Bool) ?? true
                mostrarTabBar(visible)
            }

        default: break
        }
    }

    private func mostrarTabBar(_ visible: Bool) {
        guard tabBar.isHidden == visible else { return }   // ya está como toca
        if visible {
            // isHidden se quita ANTES de animar: si se deja para el completion,
            // el fundido ocurre sobre una vista oculta y la barra aparece de
            // golpe al final en vez de entrar suave.
            tabBar.alpha = 0
            tabBar.isHidden = false
            view.setNeedsLayout()
            UIView.animate(withDuration: 0.16) { self.tabBar.alpha = 1 }
        } else {
            UIView.animate(withDuration: 0.16) {
                self.tabBar.alpha = 0
            } completion: { _ in
                self.tabBar.isHidden = true
                self.view.setNeedsLayout()
            }
        }
    }

    /// Marca el documento como "nativo" en CADA carga.
    ///
    /// Con evaluateJavaScript no bastaba: viewDidLoad corre ANTES de que el
    /// WebView cargue el HTML, así que la clase se añadía a un documento vacío
    /// y se perdía al llegar la página real — la sub-nav web seguía visible y
    /// quedaba duplicada con la barra nativa de abajo. Un WKUserScript en
    /// .atDocumentStart se reinyecta en cada navegación y recarga.
    private func inyectarMarcaNativa() {
        guard let wv = webView else { return }
        let js = "document.documentElement.classList.add('mp-nativo');"
        let script = WKUserScript(source: js,
                                  injectionTime: .atDocumentStart,
                                  forMainFrameOnly: true)
        wv.configuration.userContentController.addUserScript(script)
    }

    private func anunciarModoNativo() {
        registrarCanalBloqueo()
        // Refuerzo para el documento que ya esté cargado cuando llegamos aquí.
        evaluar("document.documentElement.classList.add('mp-nativo');")
        // La web pregunta por el estado del bloqueo para pintar el ajuste en
        // "Mi cuenta"; se le adelanta la disponibilidad al arrancar.
        let tipo = MPBloqueoBiometrico.shared.tipoDisponible
        let activo = MPBloqueoBiometrico.shared.activado
        evaluar("window.MP_BIOMETRIA = {tipo: '\(tipo)', activo: \(activo)};")
    }

    private func evaluar(_ js: String) {
        // El bridge puede no tener WebView todavía en el primer viewDidLoad.
        guard let wv = webView else { return }
        wv.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - UITabBarDelegate

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        guard pestanas.indices.contains(item.tag) else { return }
        let vista = pestanas[item.tag].vista
        // Reutiliza el router que ya existe; no recarga la página.
        evaluar("window.mpIrA && window.mpIrA('\(vista)');")
        // Retroalimentación táctil: detalle nativo que un WebView no da solo.
        UISelectionFeedbackGenerator().selectionChanged()
    }
}


// MARK: - Config del widget

//  MPWidgetConfig.swift — la lista de tickers que enseña el widget.
//
//  POR QUÉ HACE FALTA UN APP GROUP
//  -------------------------------
//  El widget es un proceso APARTE del contenedor web: no ve localStorage ni el
//  UserDefaults de la app. Un App Group es el único almacén que los dos pueden
//  leer, así que es el camino obligado para que la lista sea editable desde la
//  app. El comentario original de MercadosWidget.swift decía que se evitaba a
//  propósito para no añadir un modo de fallo de firma antes de un reenvío; ese
//  riesgo se acota así:
//
//    · Si el App Group NO está habilitado, `defaults` es nil y todo el mundo
//      cae a `porDefecto`, que son EXACTAMENTE los cuatro de siempre. El widget
//      sigue funcionando igual que antes de este archivo.
//    · Habilitarlo es un paso manual en el portal de Apple + la capability en
//      los DOS targets (App y WidgetMercados). Hasta que se haga, la edición
//      desde la app se guarda pero el widget no la ve.
//
//  PASO MANUAL PENDIENTE: en developer.apple.com → Identifiers → App Groups,
//  crear `group.app.miportafolio`; luego en Xcode, Signing & Capabilities →
//  + Capability → App Groups, marcarlo en el target App y en WidgetMercados.
//

enum MPWidgetConfig {
    /// Tiene que coincidir con el que se marque en las dos capabilities.
    static let appGroup = "group.app.miportafolio"
    private static let clave = "mp.widget.tickers"

    /// Los de fábrica. Mismo orden y mismos instrumentos que el widget traía
    /// escritos a mano, para que un widget sin configurar no cambie de aspecto.
    static let porDefecto = ["^MXX", "USDMXN=X", "SPY", "CETES28"]

    /// Máximo que caben en un widget mediano sin encoger la tipografía.
    static let tope = 4

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroup)
    }

    /// Lo que debe pintar el widget. Nunca vacío: si no hay nada guardado, o el
    /// App Group no está disponible, devuelve los de fábrica.
    static var tickers: [String] {
        guard let guardados = defaults?.array(forKey: clave) as? [String] else {
            return porDefecto
        }
        let limpios = guardados
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
            .filter { !$0.isEmpty }
        return limpios.isEmpty ? porDefecto : Array(limpios.prefix(tope))
    }

    /// Guarda lo que manda el JS y pide a WidgetKit que se recargue. Sin la
    /// recarga el widget seguiría con su última línea de tiempo hasta que el
    /// sistema decidiera refrescarlo, que puede tardar media hora.
    static func guardar(_ tickers: [String]) {
        let limpios = tickers
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
            .filter { !$0.isEmpty }
        guard let d = defaults else { return }   // sin App Group no hay dónde
        d.set(Array(limpios.prefix(tope)), forKey: clave)
        #if canImport(WidgetKit)
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadTimelines(ofKind: "MercadosWidget")
        }
        #endif
    }
}
