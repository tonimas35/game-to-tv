# «Juegos del Salón» para Android TV, Google TV y Fire TV

App Android (`io.gametotv.android`) con el servidor de los juegos dentro, como
el modo tele de LG. Guía para instalarla y usarla: [docs/tele-android.md](../../docs/tele-android.md).

## Piezas

| Archivo | Qué hace |
|---|---|
| `app/src/main/java/io/gametotv/android/MainActivity.java` | `WebView` a pantalla completa. Pantalla de carga (`assets/loading.html`), arranca o reutiliza el servidor, espera a `http://127.0.0.1:8090/info` y abre la página de la tele. Al salir, descarga la página (`about:blank`) para que el servidor pueda apagarse solo. Teclas del mando (ver `Keys.java`). |
| `NodeService.java` | Servicio en primer plano en su propio proceso (`:node`): copia el proyecto de Node fuera del APK si hace falta y arranca Node con `src/tv-service/android.js`. Node solo arranca una vez por proceso: cuando el servidor se apaga, el proceso termina. |
| `NodeJni.java` + `src/main/cpp/native-lib.cpp` | El puente JNI documentado por [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) (`node::Start` con argv contiguo y stdout/stderr a logcat, etiqueta `g2t-node`). |
| `NodeBundle.java` | Copia `assets/nodejs-project/` a `files/nodejs-project/` la primera vez y cada vez que cambia el APK (versión o fecha de instalación), con la lista de `files.txt`. |
| `Net.java` | IP de la tele para el QR con `ConnectivityManager` (cable, luego Wi‑Fi; nunca VPN ni 169.254). |
| `Keys.java` | Mando → página: flechas, OK = Enter, Atrás = Escape (o salir desde el menú principal), teclas multimedia. Con pruebas JUnit (`src/test/`). |
| `res/` | Icono (el mismo dibujo que el de LG: `npm run icons`) y banner de 320x180 (`python3 make-banner.py`). |
| `get-libnode.sh` | Descarga nodejs-mobile (v18.20.4, comprobado con SHA-256) en `app/libnode/` (no se sube a git). |
| `sideload.keystore` | Clave de firma: **solo para instalar a mano por ADB; no es una clave de tienda**. Está en el repositorio a propósito, para que cada APK nuevo se pueda instalar encima del anterior con `adb install -r`. Contraseñas en `gradle.properties`. |
| `ci/` | Lo que usa `.github/workflows/android.yml`: empaquetar los APK y la prueba en el emulador (`emulator-check.js`: Node, `/info`, escala y teclas por DevTools). |

El proyecto de Node que va en `assets/nodejs-project/` lo genera Gradle antes
de compilar (`node scripts/android-bundle.js`, ver
`src/drivers/android/bundle.js`): el servidor, los juegos, `public/` y las
dependencias de producción (`ws`, `qrcode`, `pngjs`), unos 1,3 MB.

## Compilar

Lo normal es dejar que lo haga GitHub Actions (artefacto
`juegos-del-salon-android`). En local hace falta el SDK de Android (con el NDK
y CMake 3.22.1), JDK 17, Gradle 8.9 y Node:

```bash
npm install
bash apps/android-tv/get-libnode.sh
cd apps/android-tv
gradle :app:assembleRelease            # app/build/outputs/apk/release/app-<abi>-release.apk
gradle :app:testReleaseUnitTest        # pruebas de Keys.java
gradle -Pg2tAbis=x86_64 :app:assembleRelease   # para un emulador x86_64
```

Versiones: `versionName` es la de `package.json` y `versionCode` sale de ella
(0.7.0 → 70000). `minSdk` 24 (lo pide libnode de nodejs-mobile), `targetSdk` y
`compileSdk` 34.

## Procesos y memoria

- Proceso principal: la actividad y su `WebView` (la página de la tele).
- Proceso `:node`: el servicio en primer plano con Node (`--max-old-space-size=128`).
  Se apaga solo 15 min después de quedarse sin pantalla ni jugadores
  (`src/tv-service/android.js` termina el proceso con SIGKILL, como
  `Process.killProcess`). Si al abrir la app la IP de la tele ha cambiado, la
  app lo para (`ACTION_STOP`) y arranca otro.
- `files/datos/estado.json` dice si el servidor está arrancando, en marcha o
  con error; la app lo enseña si `/info` no contesta.
