//
//  MPResena.swift — pide la calificación con el diálogo del sistema
//
//  POR QUÉ ASÍ
//  -----------
//  El diálogo lo controla Apple, no la app: aunque se llame diez veces, iOS lo
//  muestra como mucho tres veces al año por usuario y decide si aparece o no.
//  Por eso la petición no puede colgar de un botón que diga "califícanos" —eso
//  viola la guía 1.1 de App Store y además engaña: el usuario pulsa y no pasa
//  nada—. Tiene que salir sola, en un buen momento.
//
//  El "buen momento" lo decide el JS (ver `mp_resena.js`), que es quien sabe si
//  el usuario tiene cartera cargada y cuántas veces ha abierto la app. Aquí solo
//  queda la parte que necesita UIKit: encontrar la escena y llamar a StoreKit.
//
//  TRES CAMINOS POR VERSIÓN
//  ------------------------
//  El target es iOS 13, así que hay que cubrir tres APIs. La vieja sin escena
//  está obsoleta desde iOS 14 pero es la única que existe en 13, y quitarla
//  dejaría sin reseñas a quien no ha actualizado.
//

import UIKit
import StoreKit

enum MPResena {

    /// Pide el diálogo de calificación si el sistema quiere mostrarlo.
    /// No devuelve nada a propósito: es imposible saber si se mostró, y
    /// fingir que se sabe llevaría a contar mal en el lado del JS.
    ///
    /// @MainActor porque `AppStore.requestReview(in:)` lo está desde iOS 18, y
    /// sin esto no compila. No cuesta nada: quien llama es el manejador de
    /// mensajes del WKWebView, que ya corre en el hilo principal.
    @MainActor
    static func pedir(desde vista: UIView?) {
        // En la escena correcta y no en la primera que aparezca: con varias
        // ventanas (iPad, Stage Manager) la petición se perdería.
        let escena = vista?.window?.windowScene
            ?? UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }

        guard let escena else { return }

        if #available(iOS 18.0, *) {
            AppStore.requestReview(in: escena)
        } else if #available(iOS 14.0, *) {
            SKStoreReviewController.requestReview(in: escena)
        } else {
            SKStoreReviewController.requestReview()
        }
    }
}
