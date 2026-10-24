# Amazon Fire TV

Las Fire TV usan el driver **`android`** (`src/drivers/android/`): la app
«Juegos del Salón» con el servidor dentro de la tele, instalada con `adb`.

```bash
game-to-tv tv add salon 192.168.1.61 --driver android
game-to-tv tv pair salon
game-to-tv tv install salon
```

Guía completa (opciones para desarrolladores, «Depuración ADB», instalar con
`adb` a secas): [docs/tele-android.md](../../../docs/tele-android.md).

Este driver (`firetv`) solo queda para que `--driver firetv` explique esto.
