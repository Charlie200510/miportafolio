import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // appId = bundle ID (iOS) y applicationId (Android). Es PERMANENTE una vez
  // publicado en cada tienda, así que lo dejamos neutral para ambas plataformas.
  appId: 'app.miportafolio',
  appName: 'Mi Portafolio',
  webDir: 'www',
  bundledWebRuntime: false,
  ios: {
    contentInset: 'always',          // respeta safe areas (notch, home indicator)
    backgroundColor: '#FAF8F3',
    overrideUserAgent: 'MiPortafolio-iOS',
    scheme: 'MiPortafolio',
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    backgroundColor: '#FAF8F3',
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
      backgroundColor: '#FAF8F3',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      iosSpinnerStyle: 'small',
      spinnerColor: '#9C5D12',
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#FAF8F3',
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
