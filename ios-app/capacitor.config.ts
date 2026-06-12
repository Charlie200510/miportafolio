import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.miportafolio.ios',
  appName: 'Mi Portafolio',
  webDir: 'www',
  bundledWebRuntime: false,
  ios: {
    contentInset: 'always',          // respeta safe areas (notch, home indicator)
    backgroundColor: '#0a0a0b',
    overrideUserAgent: 'MiPortafolio-iOS',
    scheme: 'MiPortafolio',
    limitsNavigationsToAppBoundDomains: false,
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
      launchAutoHide: false,
      launchShowDuration: 1200,
      backgroundColor: '#0a0a0b',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      iosSpinnerStyle: 'small',
      spinnerColor: '#22c55e',
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0a0a0b',
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
