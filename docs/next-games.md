# Próximos juegos

Ideas aprobadas para añadir a game-to-tv, con lo que ya está decidido (y su
estado). Cada juego se hace con nombre, textos y gráficos propios: las
**mecánicas** de juego no tienen dueño, pero los nombres comerciales,
personajes e ilustraciones sí.

## El Infiltrado

**✅ Disponible desde 0.4.0** (`src/games/infiltrado/`, pruebas en
`test/infiltrado.test.js` y `test/browser-infiltrado.js`).

> Inspirado en la mecánica de juegos de deducción social tipo «spy». Nombre,
> lugares y textos propios.

- **Jugadores:** 3 a 6 (mejor con 4 o más).
- **Idea:** todos reciben en su móvil el mismo **lugar secreto** (por ejemplo
  «Un camping», «La consulta del dentista») y un papel dentro de él… menos
  uno: **el infiltrado**, que solo ve «Eres el infiltrado». Por turnos se hacen
  preguntas en voz alta; los demás intentan descubrir al infiltrado sin dar
  tantas pistas que él adivine el lugar.
- **Por qué encaja tan bien:** la información secreta va en cada móvil y la
  tele hace de mesa común.
- **Tele:** de quién es el turno, reloj de la ronda (p. ej. 6–8 min), lista de
  lugares posibles (ayuda al infiltrado y a los demás), votación y revelación
  final con su animación.
- **Móvil:** tu lugar y tu papel (o «Eres el infiltrado»), botón para
  ocultarlo rápido, botón «Acusar» para abrir una votación y, para el
  infiltrado, «¡Sé el lugar!» para arriesgarse a adivinarlo.
- **Final de ronda:**
  - Los demás aciertan al infiltrado en una votación → ganan ellos.
  - Acusan a un inocente, se acaba el tiempo o el infiltrado adivina el lugar
    → gana el infiltrado.
- **Puntuación:** a varias rondas, rotando quién empieza; marcador en la tele.
- **Contenido:** una lista propia de 30–40 lugares con 5–7 papeles cada uno,
  en castellano, más la opción de añadir lugares propios (como las palabras
  secretas de «Dibuja y adivina»).
- **Técnica:** sin animaciones pesadas (texto + tarjetas), así que va sobrado
  en la tele LG en modo tele. Nunca enviar el lugar al móvil del infiltrado ni
  a la tele antes de la revelación (pruebas «sin chivatazos», como en Dibuja).

## Encuentra al asesino

**🔜 Pendiente.**

> Juego de deducción tipo «¿quién, con qué y dónde?», con nombre, personajes,
> tablero e ilustraciones propios.

- **Jugadores:** 3 a 6.
- **Idea:** hay un **culpable**, un **arma** y un **lugar** ocultos. El resto
  de cartas se reparten entre los jugadores. Por turnos alguien lanza una
  sospecha («Fulano, en la cocina, con la sartén») y el siguiente jugador que
  pueda desmentirla le enseña **en secreto** una de sus cartas. Gana quien
  haga la acusación correcta; quien falla la acusación queda eliminado (pero
  sigue enseñando cartas).
- **El toque de la casa:** los **sospechosos son los propios jugadores** (sus
  nombres de la partida) y las armas son cosas de casa y de supermercado de
  marca blanca (la fregona, el táper, la sartén, el rodillo, el mando de la
  tele…). Lugares: cocina, salón, baño, terraza, trastero, garaje…
- **Móvil = carpeta secreta:** tus cartas, una **hoja de notas que se tacha
  sola** con lo que vas viendo, el formulario de sospecha/acusación y, cuando
  te toca desmentir, elegir qué carta enseñar (solo la ve quien preguntó).
- **Tele = la casa:** plano con las habitaciones, de quién es el turno, la
  sospecha en grande, «Fulano le ha enseñado una carta a Mengano» (sin decir
  cuál) y la revelación final con su momento dramático.
- **Simplificación:** sin dados ni casillas para que sea ágil: en tu turno
  eliges habitación (como mucho a una «de distancia», o libre en modo
  rápido).
- **Técnica:** turnos y tarjetas, sin animaciones pesadas: va sobrado en la
  tele en modo tele. Pruebas «sin chivatazos»: la solución nunca sale del
  servidor antes de la acusación final y las cartas enseñadas solo llegan al
  móvil de quien preguntó.
