//
//  MercadosWidget.swift — Widget de pantalla de inicio (Mi Portafolio)
//
//  Muestra la cintilla de mercados sin abrir la app. Los datos salen de los
//  mismos endpoints que alimentan el Periódico.
//
//  POR QUÉ EXISTE
//  --------------
//  Un WidgetKit corre FUERA del contenedor web: es un proceso aparte que el
//  sistema despierta en su propia línea de tiempo. Es, literalmente, lo que un
//  wrapper de WebView no puede hacer, y de paso resuelve el caso de uso más
//  frecuente del usuario mexicano (ver el peso y CETES de un vistazo) sin
//  entrar a la app.
//
//  QUÉ ENSEÑA
//  ----------
//  La lista la elige el usuario desde Analizar → Tus listas. Viaja por el App
//  Group (ver MPWidgetConfig). Si el App Group no está habilitado todavía, o si
//  el usuario nunca la tocó, se usan los cuatro de siempre: IPC, USD/MXN,
//  S&P 500 y CETES 28 días.
//
//  PALETA
//  ------
//  Espejo de mp-tokens.css. La app dejó de ser oscura, y un widget con fondo
//  #0B0B0A junto a un ícono claro se lee como de otra aplicación.
//

import WidgetKit
import SwiftUI

// MARK: - Modelo

struct Cotizacion {
    let nombre: String       // "IPC", "USD/MXN", "CETES 28d"
    let valor: String        // ya formateado
    let variacion: Double?   // nil cuando el dato no tiene variación (CETES)
}

struct EntradaMercados: TimelineEntry {
    let date: Date
    let cotizaciones: [Cotizacion]
    let actualizado: Date?
    let error: Bool

    /// Marcador para la galería de widgets y para los estados de carga.
    static let muestra = EntradaMercados(
        date: Date(),
        cotizaciones: [
            Cotizacion(nombre: "IPC",       valor: "66.45",   variacion: 0.23),
            Cotizacion(nombre: "USD/MXN",   valor: "17.2400", variacion: -0.47),
            Cotizacion(nombre: "S&P 500",   valor: "776.88",  variacion: 0.31),
            Cotizacion(nombre: "CETES 28d", valor: "9.50%",   variacion: nil),
        ],
        actualizado: Date(),
        error: false
    )
}

// MARK: - Origen de datos

enum APIMercados {
    static let base = "https://miportafolio.uk"

    /// Trae índices/divisas y la tasa de CETES en paralelo. Nunca lanza: si algo
    /// falla, devuelve lo que sí llegó para que el widget no quede en blanco.
    static func cargar() async -> EntradaMercados {
        let deseados = MPWidgetConfigWidget.tickers
        let quiereCetes = deseados.contains("CETES28")

        async let mercados = pedirMercados(deseados.filter { $0 != "CETES28" })
        async let cetes = quiereCetes ? pedirCetes() : nil

        var filas: [Cotizacion] = await mercados
        if quiereCetes, let c = await cetes {
            filas.append(Cotizacion(nombre: "CETES 28d",
                                    valor: String(format: "%.2f%%", c),
                                    variacion: nil))
        }
        return EntradaMercados(date: Date(),
                               cotizaciones: filas,
                               actualizado: filas.isEmpty ? nil : Date(),
                               error: filas.isEmpty)
    }

    /// Nombre corto para los instrumentos que la app nombra distinto que Yahoo.
    /// Para cualquier otro ticker se usa el ticker tal cual, que es lo que el
    /// usuario tecleó y por tanto lo que reconoce.
    private static let etiquetas: [String: String] = [
        "^MXX": "IPC", "NAFTRAC.MX": "IPC",
        "USDMXN=X": "USD/MXN", "MXN=X": "USD/MXN",
        "^GSPC": "S&P 500", "SPY": "S&P 500",
        "^IXIC": "Nasdaq", "QQQ": "Nasdaq-100",
        "^DJI": "Dow Jones", "EURMXN=X": "EUR/MXN",
    ]

    /// Cuántos decimales pide cada cosa: una divisa a dos decimales pierde
    /// información y un índice a cuatro se ve como un error.
    private static func decimales(_ ticker: String) -> Int {
        ticker.hasSuffix("=X") ? 4 : 2
    }

    private static func pedirMercados(_ tickers: [String]) async -> [Cotizacion] {
        guard !tickers.isEmpty,
              let url = URL(string: "\(base)/api/periodico/mercados") else { return [] }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let raiz = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }

            // El backend agrupa por bloques y cotiza algunos índices vía ETF
            // (NAFTRAC para el IPC, SPY para el S&P), así que se busca en todos
            // los grupos y por ticker Y por nombre.
            let grupos = ["indices_us", "indices_mundo", "divisas", "commodities", "tasas", "crypto"]
            let todos: [[String: Any]] = grupos.flatMap { raiz[$0] as? [[String: Any]] ?? [] }

            /// Equivalencias: si el usuario pide ^MXX y el backend lo sirve como
            /// NAFTRAC.MX, tiene que encontrarlo igual.
            let alias: [String: [String]] = [
                "^MXX": ["^MXX", "NAFTRAC.MX"], "NAFTRAC.MX": ["NAFTRAC.MX", "^MXX"],
                "USDMXN=X": ["USDMXN=X", "MXN=X"], "MXN=X": ["MXN=X", "USDMXN=X"],
                "^GSPC": ["^GSPC", "SPY"], "SPY": ["SPY", "^GSPC"],
            ]

            var filas: [Cotizacion] = []
            for t in tickers.prefix(MPWidgetConfigWidget.tope) {
                let claves = alias[t] ?? [t]
                let etiqueta = etiquetas[t] ?? t
                guard let d = todos.first(where: { fila in
                    let ft = fila["ticker"] as? String ?? ""
                    let fn = fila["nombre"] as? String ?? ""
                    return claves.contains(ft) || fn == etiqueta
                }) else { continue }
                filas.append(fila(d, etiqueta: etiqueta, decimales: decimales(t)))
            }
            return filas
        } catch {
            return []
        }
    }

    private static func pedirCetes() async -> Double? {
        guard let url = URL(string: "\(base)/api/renta-fija/mx") else { return nil }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let raiz = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let cetes = raiz?["cetes"] as? [String: Any]
            let tasas = cetes?["tasas"] as? [String: Any]
            let t28 = tasas?["28"] as? [String: Any]
            return t28?["tasa_pct"] as? Double
        } catch {
            return nil
        }
    }

    private static func fila(_ d: [String: Any], etiqueta: String, decimales: Int) -> Cotizacion {
        let precio = d["precio"] as? Double ?? 0
        // `retorno`/`cambio_pct` puede venir null si el backend lo saneó.
        let cambio = d["cambio_pct"] as? Double
        let fmt = NumberFormatter()
        fmt.numberStyle = .decimal
        fmt.minimumFractionDigits = decimales
        fmt.maximumFractionDigits = decimales
        let texto = fmt.string(from: NSNumber(value: precio)) ?? "—"
        return Cotizacion(nombre: etiqueta, valor: texto, variacion: cambio)
    }
}

// MARK: - Config compartida (copia para el target del widget)

/// El target del widget compila sus propios archivos: MPWidgetConfig.swift vive
/// en el target App. Esta copia mínima evita tener que añadir aquel archivo a
/// los dos targets, que es un cambio en el project.pbxproj fácil de perder en
/// un `cap sync`. Los valores tienen que coincidir con los de allá.
enum MPWidgetConfigWidget {
    static let appGroup = "group.app.miportafolio"
    static let porDefecto = ["^MXX", "USDMXN=X", "SPY", "CETES28"]
    static let tope = 4

    static var tickers: [String] {
        guard let g = UserDefaults(suiteName: appGroup),
              let guardados = g.array(forKey: "mp.widget.tickers") as? [String] else {
            return porDefecto
        }
        let limpios = guardados
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
            .filter { !$0.isEmpty }
        return limpios.isEmpty ? porDefecto : Array(limpios.prefix(tope))
    }
}

// MARK: - Timeline

struct ProveedorMercados: TimelineProvider {
    func placeholder(in context: Context) -> EntradaMercados { .muestra }

    func getSnapshot(in context: Context, completion: @escaping (EntradaMercados) -> Void) {
        if context.isPreview { completion(.muestra); return }
        Task { completion(await APIMercados.cargar()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<EntradaMercados>) -> Void) {
        Task {
            let entrada = await APIMercados.cargar()
            // Los cierres se mueven despacio y el sistema racionea los refrescos:
            // 30 min es un ritmo que iOS respeta sin castigar el presupuesto.
            let siguiente = Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date().addingTimeInterval(1800)
            completion(Timeline(entries: [entrada], policy: .after(siguiente)))
        }
    }
}

// MARK: - Paleta (espejo de los tokens de mp-tokens.css)

enum Tinta {
    static let papel   = Color(red: 0.937, green: 0.945, blue: 0.961)  // #EFF1F5
    static let panel   = Color(red: 1.000, green: 1.000, blue: 1.000)  // #FFFFFF
    static let regla   = Color(red: 0.882, green: 0.894, blue: 0.918)  // #E1E4EB
    static let tinta1  = Color(red: 0.078, green: 0.086, blue: 0.106)  // #14161B
    static let tinta3  = Color(red: 0.345, green: 0.369, blue: 0.420)  // #585E6B
    static let sello   = Color(red: 0.549, green: 0.322, blue: 0.047)  // #8C520C
    static let alza    = Color(red: 0.059, green: 0.361, blue: 0.200)  // #0F5C33
    static let baja    = Color(red: 0.588, green: 0.141, blue: 0.094)  // #962418
}

// MARK: - Vistas

/// Cabecera: nombre de la app y filete. Sin la regla doble del masthead viejo —
/// esa venía del lenguaje "periódico impreso" que la app ya no usa.
struct Cabecera: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Mi Portafolio")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Tinta.sello)
            Rectangle().fill(Tinta.regla).frame(height: 1)
        }
    }
}

struct FilaCotizacion: View {
    let c: Cotizacion
    var compacta: Bool = false

    private var colorVar: Color {
        guard let v = c.variacion else { return Tinta.tinta3 }
        return v > 0 ? Tinta.alza : (v < 0 ? Tinta.baja : Tinta.tinta3)
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            // El NOMBRE en sans y la CIFRA en monoespaciada: la misma regla que
            // sigue la app desde que se limpió la tipografía. La mono es para
            // números y claves, nunca para etiquetas.
            Text(c.nombre)
                .font(.system(size: compacta ? 10 : 11, weight: .semibold))
                .foregroundStyle(Tinta.tinta3)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
            Spacer(minLength: 4)
            Text(c.valor)
                .font(.system(size: compacta ? 13 : 15, weight: .semibold, design: .monospaced))
                .foregroundStyle(Tinta.tinta1)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            if let v = c.variacion {
                Text(String(format: "%@%.2f%%", v >= 0 ? "▲" : "▼", abs(v)))
                    .font(.system(size: compacta ? 9 : 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(colorVar)
                    .monospacedDigit()
                    .lineLimit(1)
            }
        }
    }
}

struct VistaMercados: View {
    var entry: EntradaMercados
    @Environment(\.widgetFamily) var familia

    private var compacta: Bool { familia == .systemSmall }

    var body: some View {
        VStack(alignment: .leading, spacing: compacta ? 8 : 10) {
            Cabecera()

            if entry.error {
                Text("Sin conexión")
                    .font(.system(size: 12))
                    .foregroundStyle(Tinta.tinta3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(Array(entry.cotizaciones.prefix(compacta ? 3 : 4).enumerated()), id: \.offset) { _, c in
                    FilaCotizacion(c: c, compacta: compacta)
                }
            }

            Spacer(minLength: 0)

            if let a = entry.actualizado {
                // Con la hora sola no se sabe si es la del dato o la del reloj.
                // WidgetKit refresca cada ~30 min y iOS puede espaciarlo más, así
                // que la etiqueta es lo que evita leer un precio viejo como si
                // fuera de ahora mismo.
                HStack(spacing: 4) {
                    Text("Actualizado")
                    Text(a, format: .dateTime.hour().minute())
                        .monospacedDigit()
                }
                .font(.system(size: 9))
                .foregroundStyle(Tinta.tinta3.opacity(0.8))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Widget

struct MercadosWidget: Widget {
    let kind = "MercadosWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ProveedorMercados()) { entry in
            if #available(iOS 17.0, *) {
                VistaMercados(entry: entry)
                    .padding(14)
                    .containerBackground(Tinta.panel, for: .widget)
            } else {
                VistaMercados(entry: entry)
                    .padding(14)
                    .background(Tinta.panel)
            }
        }
        .configurationDisplayName("Mercados MX")
        .description("IPC, dólar, S&P y CETES de un vistazo. Elige qué ver desde la app.")
        .supportedFamilies([.systemSmall, .systemMedium])
        .contentMarginsDisabled()
    }
}

@main
struct PaqueteWidgets: WidgetBundle {
    var body: some Widget {
        MercadosWidget()
    }
}
