# Cómo colaborar

¡Gracias por querer ayudar! Juegos nuevos, soporte para otras teles, arreglos
y mejoras de la documentación son bienvenidos.

## Preparar el entorno

```bash
git clone <este repositorio>
cd game-to-tv
npm install
npm test            # todas las pruebas (sin tele ni red)
npm run check       # JavaScript del navegador en ES2019
node bin/game-to-tv.js start
```

Opcional: `npm run test:browser` (prueba con Chromium sin pantalla; necesita
Playwright: `npm install -g playwright && npx playwright install chromium`).

## Normas

- **Idioma**: la interfaz y la documentación están en **español de España**.
  El código (nombres de variables y funciones) y sus comentarios, en inglés y
  breves.
- **Navegador**: todo el JavaScript que corre en la tele o en el móvil debe ser
  **ES2019** sin dependencias ni CDNs (`npm run check` lo comprueba). La tele LG
  de referencia usa Chromium 87.
- **Rendimiento en la tele**: sin `shadowBlur` ni degradados grandes por
  fotograma; canvas dimensionados con `capDpr()`. Ver
  [docs/crear-un-juego.md](docs/crear-un-juego.md).
- **Pruebas**: cada juego y cada driver con sus pruebas en `test/`, sin
  depender de una tele real (usa servidores y comandos falsos, como en
  `test/webos.test.js`).
- **Dependencias**: las mínimas, con versión exacta, y siempre con
  `package-lock.json`.

## Privacidad (importante)

Este repositorio es público. **Nunca** subas:

- `~/.game-to-tv/config.json` ni ninguna `client-key` de una tele;
- IP reales (usa ejemplos como `192.168.1.50`), nombres de personas reales,
  fotos de personas, números de serie, correos;
- dibujos de la galería ni fotos del modo ambiente.

En capturas y pruebas usa nombres inventados («Ana», «Berto»…).

## Proponer cambios

1. Crea una rama, haz commits pequeños con mensajes claros.
2. Asegúrate de que pasan `npm test` y `npm run check`.
3. Abre un *pull request* explicando qué cambia y cómo lo has probado (si es
   en una tele real, di el modelo y la versión del sistema).

## Ideas

Mira [docs/roadmap.md](docs/roadmap.md). Para un juego nuevo:
[docs/crear-un-juego.md](docs/crear-un-juego.md). Para otra tele:
[docs/drivers.md](docs/drivers.md).
