import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // appId = bundle ID (iOS) y applicationId (Android). Es PERMANENTE una vez
  // publicado en cada tienda, así que lo dejamos neutral para ambas plataformas.
  appId: 'app.miportafolio',
  appName: 'Mi Portafolio',
  webDir: 'www',
  bundledWebRuntime: false,
  // OJO: estos colores son ESPEJO de mp-tokens.css y no hay forma de que los
  // lea de ahí. Se quedaron en #EFF1F5 —el papel gris azulado anterior al
  // rediseño— y en el ocre #8C520C del acento viejo, así que el splash, el
  // fondo nativo y el spinner contradecían a la app durante el segundo y medio
  // que más se mira: el arranque. Si se tocan los tokens, tocar aquí y en
  // LaunchScreen.storyboard, que tiene el mismo color en componentes RGB.
  ios: {
    contentInset: 'always',          // respeta safe areas (notch, home indicator)
    backgroundColor: '#EDEFE8',
    overrideUserAgent: 'MiPortafolio-iOS',
    scheme: 'MiPortafolio',
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    backgroundColor: '#EDEFE8',
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,  // poner true solo para depurar en dev
  },
  server: {
    // Modo dev: levantar `python3 backend/app.py` y usar tu IP local + 5001
    // Para PRODUCCIÓN: las URL absolutas en frontend usan window.MP_API_BASE (ver app.js)
    // url: 'http://192.168.1.X:5001',  // descomentar y ajustar IP para hot reload contra backend local
    androidScheme: 'https',
    iosScheme: 'capacitor',
    cleartext: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 1500,
      backgroundColor: '#EDEFE8',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      iosSpinnerStyle: 'small',
      spinnerColor: '#1B4D3E',
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#EDEFE8',
      overlaysWebView: false,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    Preferences: {
      group: 'app.miportafolio.shared',
    },
  },
};

export default config;
