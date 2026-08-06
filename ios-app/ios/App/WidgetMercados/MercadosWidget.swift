//
//  MercadosWidget.swift — Widget de pantalla de inicio (Mi Portafolio)
//
//  Muestra la cintilla mexicana —IPC, USD/MXN y CETES 28 días— sin abrir la
//  app. Los datos salen de los mismos endpoints que alimentan el Periódico.
//
//  POR QUÉ EXISTE
//  --------------
//  Un WidgetKit corre FUERA del contenedor web: es un proceso aparte que el
//  sistema despierta en su propia línea de tiempo. Es, literalmente, lo que un
//  wrapper de WebView no puede hacer, y de paso resuelve el caso de uso más
//  frecuente del usuario mexicano (ver el peso y CETES de un vistazo) sin
//  entrar a la app.
//
//  DATOS: se piden directo a la API pública. A propósito NO se usa un App
//  Group: eso obligaría a registrar el grupo en el portal de Apple y añade un
//  modo de fallo de firma justo antes de un reenvío. Si más adelante se quiere
//  el valor de la cartera del usuario, ese es el camino (ver README).
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
            Cotizacion(nombre: "IPC",       valor: "66.45",  variacion: 0.23),
            Cotizacion(nombre: "USD/MXN",   valor: "17.2400", variacion: -0.47),
            Cotizacion(nombre: "CETES 28d", valor: "9.50%",  variacion: nil),
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
        async let mercados = pedirMercados()
        async let cetes = pedirCetes()

        var filas: [Cotizacion] = await mercados
        if let c = await cetes {
            filas.append(Cotizacion(nombre: "CETES 28d",
                                    valor: String(format: "%.2f%%", c),
                                    variacion: nil))
        }
        return EntradaMercados(date: Date(),
                               cotizaciones: filas,
                               actualizado: filas.isEmpty ? nil : Date(),
                               error: filas.isEmpty)
    }

    private static func pedirMercados() async -> [Cotizacion] {
        guard let url = URL(string: "\(base)/api/periodico/mercados") else { return [] }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let raiz = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }

            // El backend cotiza los índices vía ETF (NAFTRAC para el IPC, SPY
            // para el S&P), así que se busca por ticker Y por nombre.
            let grupos = ["indices_us", "indices_mundo", "divisas"]
            let todos: [[String: Any]] = grupos.flatMap { raiz[$0] as? [[String: Any]] ?? [] }

            func buscar(_ tickers: [String], _ nombres: [String]) -> [String: Any]? {
                todos.first { fila in
                    let t = fila["ticker"] as? String ?? ""
                    let n = fila["nombre"] as? String ?? ""
                    return tickers.contains(t) || nombres.contains(n)
                }
            }

            var filas: [Cotizacion] = []
            if let ipc = buscar(["NAFTRAC.MX", "^MXX"], ["IPC México"]) {
                filas.append(fila(ipc, etiqueta: "IPC", decimales: 2))
            }
            if let fx = buscar(["MXN=X", "USDMXN=X"], ["USD/MXN"]) {
                filas.append(fila(fx, etiqueta: "USD/MXN", decimales: 4))
            }
            if let spy = buscar(["SPY", "^GSPC"], ["S&P 500"]) {
                filas.append(fila(spy, etiqueta: "S&P 500", decimales: 2))
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
    static let fondo   = Color(red: 0.043, green: 0.043, blue: 0.039)  // #0B0B0A
    static let panel   = Color(red: 0.075, green: 0.071, blue: 0.063)  // #131210
    static let regla   = Color(red: 0.165, green: 0.153, blue: 0.129)  // #2A2721
    static let papel   = Color(red: 0.949, green: 0.933, blue: 0.894)  // #F2EEE4
    static let papel3  = Color(red: 0.604, green: 0.573, blue: 0.518)  // #9A9284
    static let sello   = Color(red: 0.843, green: 0.604, blue: 0.235)  // #D79A3C
    static let alza    = Color(red: 0.435, green: 0.682, blue: 0.494)  // #6FAE7E
    static let baja    = Color(red: 0.859, green: 0.482, blue: 0.408)  // #DB7B68
}

// MARK: - Vistas

/// Cabecera con la regla doble del masthead: es la firma visual de la app.
struct Cabecera: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("MI PORTAFOLIO")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .kerning(0.8)
                .foregroundStyle(Tinta.papel3)
            Rectangle().fill(Tinta.papel).frame(height: 1.5)
            Rectangle().fill(Tinta.regla).frame(height: 0.5)
        }
    }
}

struct FilaCotizacion: View {
    let c: Cotizacion
    var compacta: Bool = false

    private var colorVar: Color {
        guard let v = c.variacion else { return Tinta.papel3 }
        return v > 0 ? Tinta.alza : (v < 0 ? Tinta.baja : Tinta.papel3)
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(c.nombre)
                .font(.system(size: compacta ? 9 : 10, weight: .medium, design: .monospaced))
                .foregroundStyle(Tinta.papel3)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(c.valor)
                .font(.system(size: compacta ? 12 : 14, weight: .semibold, design: .monospaced))
                .foregroundStyle(Tinta.papel)
                .monospacedDigit()
            if let v = c.variacion {
                Text(String(format: "%@%.2f%%", v >= 0 ? "▲" : "▼", abs(v)))
                    .font(.system(size: compacta ? 9 : 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(colorVar)
                    .monospacedDigit()
            }
        }
    }
}

struct VistaMercados: View {
    var entry: EntradaMercados
    @Environment(\.widgetFamily) var familia

    private var compacta: Bool { familia == .systemSmall }

    var body: some View {
        VStack(alignment: .leading, spacing: compacta ? 7 : 9) {
            Cabecera()

            if entry.error {
                Text("Sin conexión")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Tinta.papel3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(Array(entry.cotizaciones.prefix(compacta ? 3 : 4).enumerated()), id: \.offset) { _, c in
                    FilaCotizacion(c: c, compacta: compacta)
                }
            }

            Spacer(minLength: 0)

            if let a = entry.actualizado {
                Text(a, format: .dateTime.hour().minute())
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(Tinta.papel3.opacity(0.8))
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
                    .padding(12)
                    .containerBackground(Tinta.fondo, for: .widget)
            } else {
                VistaMercados(entry: entry)
                    .padding(12)
                    .background(Tinta.fondo)
            }
        }
        .configurationDisplayName("Mercados MX")
        .description("IPC, dólar y CETES 28 días de un vistazo.")
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
