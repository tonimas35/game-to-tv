'use strict';
/*
 * Palabras de «Dibuja y adivina».
 *
 * Cómo añadir palabras: escríbelas dentro de la cadena de la categoría y la
 * dificultad que quieras, separadas por comas. Pueden llevar tildes, espacios
 * o guiones («caballito de mar», «ping-pong»). Si una palabra aparece dos
 * veces, solo se usa la primera. Tras guardar, reinicia el servidor.
 *
 * Dificultades: facil · media · dificil
 * (las difíciles dan más puntos al acertarlas).
 */

const RAW = {
  animales: {
    facil: 'perro, gato, pez, pájaro, vaca, cerdo, caballo, conejo, ratón, pato, oveja, serpiente, araña, elefante, jirafa, león',
    media: 'tortuga, pulpo, cangrejo, búho, mariposa, caracol, tiburón, ballena, canguro, cocodrilo, pingüino, murciélago, abeja, cebra, mono, delfín',
    dificil: 'camaleón, erizo, medusa, avestruz, flamenco, ornitorrinco, mapache, castor, armadillo, perezoso, caballito de mar, luciérnaga'
  },
  comida: {
    facil: 'manzana, plátano, pizza, helado, huevo, pan, queso, tarta, galleta, uva, zanahoria, sandía, hamburguesa, piña',
    media: 'paella, tortilla, churros, croqueta, palomitas, sándwich, espaguetis, perrito caliente, fresa, cereza, limón, aguacate, brócoli, sushi',
    dificil: 'gazpacho, bocadillo de calamares, cocido, polvorón, roscón de reyes, fondue, macarrones, turrón, salmorejo, berenjena'
  },
  objetos: {
    facil: 'llave, reloj, gafas, paraguas, libro, lápiz, tijeras, globo, vela, regalo, teléfono, mochila, zapato, sombrero',
    media: 'guitarra, cámara, linterna, martillo, candado, brújula, escoba, mando a distancia, auriculares, bombilla, calcetín, corona, maleta, cuchara',
    dificil: 'reloj de arena, telescopio, prismáticos, embudo, imán, sacacorchos, abanico, castañuelas, metrónomo, ancla, termómetro, microscopio'
  },
  acciones: {
    facil: 'correr, saltar, dormir, comer, nadar, bailar, llorar, reír, cantar, leer, beber, volar',
    media: 'cocinar, pescar, escalar, estornudar, bostezar, aplaudir, silbar, patinar, pintar, regar, barrer, conducir, fotografiar, abrazar',
    dificil: 'hacer malabares, roncar, tropezar, meditar, susurrar, hacer la compra, tender la ropa, hacer surf, soplar las velas, hacer cosquillas, tejer, desmayarse'
  },
  lugares: {
    facil: 'playa, casa, castillo, escuela, montaña, isla, granja, parque',
    media: 'hospital, aeropuerto, biblioteca, circo, iglesia, faro, estación, supermercado, cine, piscina, zoo, puente, desierto, selva',
    dificil: 'museo, cementerio, farmacia, peluquería, gasolinera, rascacielos, laberinto, pirámide, iglú, mercado, cárcel, observatorio'
  },
  profesiones: {
    facil: 'médico, bombero, policía, cocinero, pirata, payaso, pintor, astronauta',
    media: 'dentista, cartero, peluquero, jardinero, pescador, mago, piloto, camarero, granjero, enfermera, profesor, futbolista',
    dificil: 'fontanero, carpintero, arqueólogo, socorrista, detective, electricista, veterinario, cantante de ópera, domador de leones, apicultor, escultor, buzo'
  },
  naturaleza: {
    facil: 'sol, luna, estrella, árbol, flor, nube, lluvia, nieve, arcoíris, fuego, hoja, río',
    media: 'volcán, cascada, tormenta, rayo, cactus, seta, ola, palmera, girasol, roca, cueva, lago, viento',
    dificil: 'eclipse, tornado, terremoto, aurora boreal, géiser, iceberg, oasis, niebla, glaciar, marea, huracán, estrella fugaz'
  },
  deportes: {
    facil: 'fútbol, baloncesto, tenis, natación, ciclismo, esquí, boxeo, golf',
    media: 'béisbol, voleibol, kárate, surf, ping-pong, bolos, dardos, ajedrez, judo, balonmano, waterpolo',
    dificil: 'esgrima, tiro con arco, salto de pértiga, curling, remo, halterofilia, paracaidismo, gimnasia rítmica, escalada, hockey sobre hielo, triatlón, petanca'
  },
  casa: {
    facil: 'cama, silla, mesa, puerta, ventana, lámpara, sofá, bañera, televisión, escalera, nevera, espejo',
    media: 'lavadora, chimenea, cortina, almohada, ducha, horno, tostadora, microondas, armario, alfombra, váter, enchufe, estantería, buzón',
    dificil: 'persiana, tendedero, aspiradora, ventilador, radiador, perchero, lavavajillas, cafetera, tabla de planchar, felpudo, despertador, mecedora'
  },
  transporte: {
    facil: 'coche, avión, barco, tren, bici, autobús, moto, cohete',
    media: 'helicóptero, submarino, camión, tractor, patinete, taxi, ambulancia, globo aerostático, velero, ascensor, metro, tranvía',
    dificil: 'teleférico, monopatín, grúa, carruaje, hidroavión, góndola, quad, caravana, apisonadora, trineo, kayak, zepelín'
  },
  'fantasía': {
    facil: 'dragón, fantasma, bruja, princesa, robot, sirena, unicornio, monstruo, hada, rey',
    media: 'vampiro, zombi, extraterrestre, ovni, gigante, duende, caballero, varita mágica, momia, genio de la lámpara, superhéroe, alfombra voladora',
    dificil: 'cíclope, centauro, minotauro, pegaso, hombre lobo, kraken, grifo, gnomo, poción mágica, ave fénix, esqueleto, espantapájaros'
  },
  'expresiones fáciles': {
    facil: 'tengo hambre, buenas noches, feliz cumpleaños, tener frío, tener calor, tener miedo, estar enfadado, dar un abrazo, tengo sueño',
    media: 'estar en las nubes, ser uña y carne, echar una mano, romper el hielo, tirar la toalla, meter la pata, ponerse rojo, estar hecho polvo, pedir la luna, ver las estrellas, llover a cántaros, quedarse en blanco, comerse el coco, estar como una cabra',
    dificil: 'costar un ojo de la cara, tener mariposas en el estómago, buscar una aguja en un pajar, dormirse en los laureles, ser la oveja negra, irse por las ramas, estar entre la espada y la pared, hablar por los codos, dar en el clavo, ser pan comido, tomar el pelo, hacer castillos en el aire'
  }
};

const DIFFS = ['facil', 'media', 'dificil'];
const DIFF_LABEL = { facil: 'fácil', media: 'media', dificil: 'difícil' };

function key(w) {
  return String(w).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s-]+/g, ' ').trim();
}

const WORDS = [];
const seen = new Set();
Object.keys(RAW).forEach(function (cat) {
  DIFFS.forEach(function (diff) {
    String(RAW[cat][diff] || '').split(',').forEach(function (w) {
      w = w.trim().replace(/\s+/g, ' ');
      if (!w) return;
      const k = key(w);
      if (seen.has(k)) return;
      seen.add(k);
      WORDS.push({ word: w, diff: diff, cat: cat });
    });
  });
});

module.exports = {
  WORDS: WORDS,
  DIFFS: DIFFS,
  DIFF_LABEL: DIFF_LABEL,
  CATEGORIES: Object.keys(RAW)
};

if (require.main === module) {
  const by = {};
  WORDS.forEach(function (w) { by[w.cat + '/' + w.diff] = (by[w.cat + '/' + w.diff] || 0) + 1; });
  console.log(by);
  console.log('Total: ' + WORDS.length + ' palabras');
}
