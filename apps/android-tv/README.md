# «Juegos del Salón» para Android TV, Google TV y Fire TV

App Android (`io.gametotv.android`) con el servidor de los juegos dentro, como
el modo tele de LG. Guía para instalarla y usarla: [docs/tele-android.md](../../docs/tele-android.md).

## Piezas

| Archivo | Qué hace |
|---|---|
| `app/src/main/java/io/gametotv/android/MainActivity.java` | `WebView` a pantalla completa. Pantalla de carga (`assets/loading.html`), busca actualizaciones de los juegos (como mucho 4 s), arranca o reutiliza el servidor, espera a `http://127.0.0.1:8090/info` y abre la página de la tele. Si un paquete descargado no arranca, vuelve al anterior. Al salir, descarga la página (`about:blank`) para que el servidor pueda apagarse solo. Teclas del mando (ver `Keys.java`). |
| `NodeService.java` | Servicio en primer plano en su propio proceso (`:node`): arranca Node con el paquete de juegos que elige la app (uno descargado en `files/bundles/<versión>/` o el del APK, que copia fuera si hace falta) y `src/tv-service/android.js`. Node solo arranca una vez por proceso: cuando el servidor se apaga, el proceso termina. |
| `NodeJni.java` + `src/main/cpp/native-lib.cpp` | El puente JNI documentado por [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) (`node::Start` con argv contiguo y stdout/stderr a logcat, etiqueta `g2t-node`). |
| `NodeBundle.java` | Copia `assets/nodejs-project/` a `files/nodejs-project/` la primera vez y cada vez que cambia el APK (versión o fecha de instalación), con la lista de `files.txt`. |
| `Updater.java` | Actualizaciones automáticas, la parte de red: `bundle.json` de la rama `apk` con límite de tiempo estricto y descarga de `bundle.zip` comprobando tamaño y SHA-256. La URL es `BuildConfig.UPDATE_URL`; en pruebas, `adb shell setprop debug.g2t.update_url URL\|off`. |
| `BundlePolicy.java` | Qué paquete arrancar, cuándo descargar uno y qué hacer si falla (candidato a prueba, bueno, anterior, versiones malas, el APK manda si es más nuevo). Java puro, con pruebas JUnit. |
| `BundleStore.java` | Los paquetes en disco: `files/bundles/<versión>/`, el estado en `files/bundles/estado.properties`, descomprimir a una carpeta `.tmp` y renombrar, borrar los viejos. |
| `BundleFiles.java` | SHA-256 y descompresión segura del zip (nada fuera de la carpeta, límites de tamaño). Java puro, con pruebas JUnit. |
| `bundle-contract.json` | `minApp`: el `versionCode` mínimo que puede ejecutar el paquete de juegos actual. Se sube solo cuando cambia el contrato Java ↔ Node. |
| `Net.java` | IP de la tele para el QR con `ConnectivityManager` (cable, luego Wi‑Fi; nunca VPN ni 169.254). |
| `Keys.java` | Mando → página: flechas, OK = Enter, Atrás = Escape (o salir desde el menú principal), teclas multimedia. Con pruebas JUnit (`src/test/`). |
| `res/` | Icono (el mismo dibujo que el de LG: `npm run icons`) y banner de 320x180 (`python3 make-banner.py`). |
| `get-libnode.sh` | Descarga nodejs-mobile (v18.20.4, comprobado con SHA-256) en `app/libnode/` (no se sube a git). |
| `sideload.keystore` | Clave de firma: **solo para instalar a mano por ADB; no es una clave de tienda**. Está en el repositorio a propósito, para que cada APK nuevo se pueda instalar encima del anterior con `adb install -r`. Contraseñas en `gradle.properties`. |
| `ci/` | Lo que usa `.github/workflows/android.yml`: empaquetar los APK y las pruebas en el emulador (`emulator-check.js`: Node, `/info`, escala y teclas por DevTools; `ota-check.js`: actualizaciones automáticas contra un servidor falso en el PC, en `10.0.2.2`). |

El proyecto de Node que va en `assets/nodejs-project/` lo genera Gradle antes
de compilar (`node scripts/android-bundle.js`, ver
`src/drivers/android/bundle.js`): el servidor, los juegos, `public/` y las
dependencias de producción (`ws`, `qrcode`, `pngjs`), unos 1,3 MB. Su
`bundle.json` dice la versión del paquete (`0.8.0+20261024153012`: la de
`package.json` más la hora UTC del commit) y su `minApp`.

## Actualizaciones automáticas

La misma carpeta `nodejs-project`, comprimida (`bundle.zip`, unos 500 KB), se
publica con su `bundle.json` en la rama `apk` (solo desde `main` y si pasan
todas las pruebas). La app la descarga sola al abrirse, la prueba y vuelve
atrás si falla: los juegos nuevos y los arreglos llegan sin reinstalar. Solo
los cambios en Java necesitan un APK nuevo; si además cambian lo que Node
espera de Java, sube `minApp` en `bundle-contract.json`. Detalles en
[docs/tele-android.md](../../docs/tele-android.md#actualizaciones-automáticas).

```bash
node scripts/android-bundle.js --ota dist/ota --from apps/android-tv/app/build/generated/g2t/assets/nodejs-project   # lo que hace CI (desde la raíz)
```

## Compilar

Lo normal es dejar que lo haga GitHub Actions (artefacto
`juegos-del-salon-android`). En local hace falta el SDK de Android (con el NDK
y CMake 3.22.1), JDK 17, Gradle 8.9 y Node:

```bash
npm install
bash apps/android-tv/get-libnode.sh
cd apps/android-tv
gradle :app:assembleRelease            # app/build/outputs/apk/release/app-<abi>-release.apk
gradle :app:testReleaseUnitTest        # pruebas de Keys, BundlePolicy y BundleFiles
gradle -Pg2tAbis=x86_64 :app:assembleRelease   # para un emulador x86_64
```

Versiones: `versionName` es la de `package.json` y `versionCode` sale de ella
(0.8.0 → 80000; la 0.8.0 es la primera que se actualiza sola). `minSdk` 24 (lo pide libnode de nodejs-mobile), `targetSdk` y
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
