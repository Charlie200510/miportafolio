//
//  MPBloqueoBiometrico.swift — bloqueo con Face ID / Touch ID
//
//  Cubre la pantalla con un velo opaco al salir de primer plano y pide
//  biometría al volver. Es OPT-IN: apagado hasta que el usuario lo enciende
//  desde "Mi cuenta", así que el revisor de Apple nunca se topa con un muro.
//
//  POR QUÉ
//  -------
//  Es una capacidad del sistema —LocalAuthentication + el ciclo de vida real de
//  UIKit— que un WebView no puede ofrecer, y en una app que muestra el
//  patrimonio de alguien es lo que un usuario espera. El velo se pone en
//  `willResignActive`, ANTES de que iOS tome la miniatura para el conmutador de
//  apps: sin eso, el saldo quedaría visible ahí aunque la app esté bloqueada.
//

import UIKit
import LocalAuthentication

final class MPBloqueoBiometrico {

    static let shared = MPBloqueoBiometrico()
    private init() {}

    private static let clavePreferencia = "mp.bloqueoBiometrico.v1"

    /// Lo enciende/apaga el usuario desde la web (window.mpBloqueo).
    var activado: Bool {
        get { UserDefaults.standard.bool(forKey: Self.clavePreferencia) }
        set { UserDefaults.standard.set(newValue, forKey: Self.clavePreferencia) }
    }

    private weak var ventana: UIWindow?
    private var velo: UIView?
    private var autenticando = false

    func configurar(ventana: UIWindow?) {
        self.ventana = ventana
    }

    // MARK: - Ciclo de vida

    /// Se llama en willResignActive: antes del snapshot del app switcher.
    func ocultarContenido() {
        guard activado, velo == nil, let v = ventana else { return }
        let capa = UIView(frame: v.bounds)
        capa.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        capa.backgroundColor = UIColor(red: 0.937, green: 0.945, blue: 0.961, alpha: 1)  // #EFF1F5

        let candado = UIImageView(image: UIImage(systemName: "lock.fill"))
        candado.tintColor = UIColor(red: 0.612, green: 0.365, blue: 0.071, alpha: 1)     // #9C5D12
        candado.translatesAutoresizingMaskIntoConstraints = false
        candado.contentMode = .scaleAspectFit
        capa.addSubview(candado)
        NSLayoutConstraint.activate([
            candado.centerXAnchor.constraint(equalTo: capa.centerXAnchor),
            candado.centerYAnchor.constraint(equalTo: capa.centerYAnchor),
            candado.widthAnchor.constraint(equalToConstant: 34),
            candado.heightAnchor.constraint(equalToConstant: 34),
        ])

        v.addSubview(capa)
        velo = capa
    }

    /// Se llama en didBecomeActive.
    func pedirDesbloqueo() {
        guard activado, velo != nil, !autenticando else {
            if !activado { quitarVelo() }
            return
        }
        autenticando = true

        let ctx = LAContext()
        ctx.localizedCancelTitle = "Cancelar"
        var error: NSError?

        // Con .deviceOwnerAuthentication el sistema cae al código del
        // dispositivo si no hay biometría o si falla: nunca deja al usuario
        // encerrado fuera de sus propios datos.
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            autenticando = false
            quitarVelo()   // sin forma de autenticar, no se bloquea la app
            return
        }

        ctx.evaluatePolicy(.deviceOwnerAuthentication,
                           localizedReason: "Desbloquea Mi Portafolio para ver tu cartera") { ok, _ in
            DispatchQueue.main.async {
                self.autenticando = false
                if ok { self.quitarVelo() }
                // Si falla, el velo se queda: al volver a activar la app se
                // vuelve a pedir.
            }
        }
    }

    private func quitarVelo() {
        velo?.removeFromSuperview()
        velo = nil
    }

    // MARK: - Disponibilidad

    /// Para que la web sepa si ofrecer el ajuste, y con qué nombre.
    var tipoDisponible: String {
        let ctx = LAContext()
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else {
            return "ninguno"
        }
        switch ctx.biometryType {
        case .faceID:  return "faceid"
        case .touchID: return "touchid"
        default:       return "ninguno"
        }
    }
}
