'use strict';
/*
 * «El Infiltrado»: the locations and the roles inside each one.
 * Original list, in Spanish (Spain): everyday places and a few fun ones,
 * 6 roles each (all different within a place), no brand names.
 * A round needs at most 5 roles (6 players minus the spy).
 */

const LOCATIONS = [
  { name: 'Un camping', roles: ['Monitora de actividades', 'Familia de la caravana', 'Mochilero perdido', 'Dueño del chiringuito', 'Vecino que ronca', 'Socorrista de la piscina'] },
  { name: 'La consulta del dentista', roles: ['Dentista', 'Higienista', 'Paciente con miedo', 'Niña con brackets', 'Recepcionista', 'Visitador médico'] },
  { name: 'Un barco pirata', roles: ['Capitán con pata de palo', 'Grumete', 'Cocinera de a bordo', 'Vigía', 'Prisionero', 'Cartógrafa'] },
  { name: 'Una boda', roles: ['Novia', 'Novio', 'Suegra emocionada', 'Fotógrafo', 'Camarera', 'Primo que no para de bailar'] },
  { name: 'El metro en hora punta', roles: ['Conductora', 'Músico ambulante', 'Turista con maleta', 'Oficinista dormido', 'Revisor', 'Estudiante con mochila'] },
  { name: 'Un plató de televisión', roles: ['Presentadora', 'Cámara', 'Maquillador', 'Público que aplaude', 'Concursante', 'Regidora'] },
  { name: 'Una estación de esquí', roles: ['Monitor de esquí', 'Principiante', 'Operaria del telesilla', 'Snowboarder', 'Socorrista de pistas', 'Camarero del refugio'] },
  { name: 'Un hospital', roles: ['Cirujana', 'Enfermero', 'Paciente', 'Celador', 'Visita con flores', 'Médica de guardia'] },
  { name: 'Un colegio', roles: ['Directora', 'Profesor de gimnasia', 'Alumno repetidor', 'Conserje', 'Cocinera del comedor', 'Madre del AMPA'] },
  { name: 'Un submarino', roles: ['Capitana', 'Operador del sonar', 'Cocinero', 'Mecánica', 'Marinero novato', 'Oficial del periscopio'] },
  { name: 'Una comisaría', roles: ['Inspectora', 'Agente de guardia', 'Detenido', 'Testigo nervioso', 'Abogada', 'Dibujante de retratos'] },
  { name: 'Un circo', roles: ['Payaso', 'Domadora', 'Trapecista', 'Malabarista', 'Mujer bala', 'Vendedor de palomitas'] },
  { name: 'Un crucero', roles: ['Capitana', 'Animador', 'Jubilado bailón', 'Camarera', 'Pasajero mareado', 'Cantante del espectáculo'] },
  { name: 'Una panadería', roles: ['Panadero madrugador', 'Dependienta', 'Cliente de la barra de siempre', 'Repartidor', 'Aprendiz', 'Abuela que pide fiado'] },
  { name: 'Un gimnasio', roles: ['Entrenadora personal', 'Culturista', 'Novato de enero', 'Recepcionista', 'Profesor de zumba', 'Socio que solo va a la sauna'] },
  { name: 'Un museo', roles: ['Guía', 'Vigilante de sala', 'Restauradora', 'Turista con audioguía', 'Ladrón de guante blanco', 'Escolar de excursión'] },
  { name: 'Un avión', roles: ['Piloto', 'Azafata', 'Pasajero con miedo a volar', 'Familia con bebé', 'Copiloto', 'Pasajera de la salida de emergencia'] },
  { name: 'Un concierto', roles: ['Cantante', 'Batería', 'Técnica de sonido', 'Fan de primera fila', 'Seguridad', 'Vendedor de camisetas'] },
  { name: 'Una peluquería', roles: ['Peluquera', 'Clienta de toda la vida', 'Aprendiz', 'Señor que solo quiere las puntas', 'Manicurista', 'Vecina cotilla'] },
  { name: 'Un supermercado', roles: ['Cajera', 'Reponedor', 'Carnicero', 'Cliente con prisa', 'Vigilante', 'Niño que se ha perdido'] },
  { name: 'Una biblioteca', roles: ['Bibliotecaria', 'Estudiante en exámenes', 'Jubilado con el periódico', 'Escritora', 'Niño del cuentacuentos', 'Conserje'] },
  { name: 'Una granja', roles: ['Granjera', 'Veterinario', 'Ordeñador', 'Niña de ciudad de visita', 'Tractorista', 'Espantapájaros'] },
  { name: 'Un parque de atracciones', roles: ['Operario de la montaña rusa', 'Mascota disfrazada', 'Niño mareado', 'Vendedora de algodón de azúcar', 'Pareja en la noria', 'Fotógrafo de la atracción'] },
  { name: 'Un cine', roles: ['Taquillera', 'Acomodador', 'Vendedor de palomitas', 'Pareja de la última fila', 'Crítica de cine', 'Espectador que no se calla'] },
  { name: 'Una playa', roles: ['Socorrista', 'Vendedor de helados', 'Turista quemado', 'Niña con cubo y pala', 'Jubilado con sombrilla', 'Surfista'] },
  { name: 'Una oficina', roles: ['Jefa', 'Becario', 'Informático', 'Recepcionista', 'Contable', 'Compañero que calienta el táper'] },
  { name: 'Una estación espacial', roles: ['Comandante', 'Ingeniera', 'Científico', 'Turista espacial', 'Médica de a bordo', 'Piloto de la nave'] },
  { name: 'Una discoteca', roles: ['DJ', 'Portero', 'Camarera', 'Bailarín', 'Novia de despedida de soltera', 'Cliente que pide su canción'] },
  { name: 'Un restaurante elegante', roles: ['Chef', 'Sumiller', 'Camarero', 'Crítica gastronómica', 'Pareja de aniversario', 'Friegaplatos'] },
  { name: 'Un casino', roles: ['Crupier', 'Jugadora con suerte', 'Guardia de seguridad', 'Camarero', 'Millonario excéntrico', 'Tahúr'] },
  { name: 'Un mercado medieval', roles: ['Herrero', 'Juglar', 'Bruja de las pociones', 'Caballero', 'Vendedora de miel', 'Cetrero'] },
  { name: 'Una iglesia', roles: ['Cura', 'Monaguillo', 'Organista', 'Turista con cámara', 'Cantante del coro', 'Señora de primera fila'] },
  { name: 'Un zoo', roles: ['Cuidadora de leones', 'Veterinario', 'Niño con globo', 'Guía', 'Fotógrafa de naturaleza', 'Mono que se ha escapado'] },
  { name: 'Un teatro', roles: ['Actriz principal', 'Apuntador', 'Tramoyista', 'Taquillero', 'Espectador que tose', 'Directora'] },
  { name: 'Un spa', roles: ['Masajista', 'Recepcionista', 'Clienta con pepinos en los ojos', 'Encargado del circuito termal', 'Pareja de luna de miel', 'Ejecutivo estresado'] },
  { name: 'Una base militar', roles: ['General', 'Sargento', 'Recluta', 'Cocinero del cuartel', 'Piloto de helicóptero', 'Médica militar'] },
  { name: 'Un tren de largo recorrido', roles: ['Maquinista', 'Revisora', 'Camarero del vagón restaurante', 'Pasajero dormido', 'Familia de vacaciones', 'Escritor misterioso'] },
  { name: 'Una obra', roles: ['Encargado', 'Albañil', 'Gruista', 'Arquitecta', 'Jubilado que mira la obra', 'Peón novato'] },
  { name: 'Un banco', roles: ['Directora de la sucursal', 'Cajero', 'Cliente con su libreta', 'Guardia de seguridad', 'Ladrón disfrazado', 'Joven que pide una hipoteca'] },
  { name: 'Un parque de bomberos', roles: ['Jefa de bomberos', 'Bombero novato', 'Conductor del camión', 'Perro de la brigada', 'Vecino que llama por su gato', 'Operadora de emergencias'] }
];

// For a «lugar propio» written with its name only (or with too few roles)
const GENERIC_ROLES = ['Visitante', 'Encargado/a', 'Cliente habitual', 'Novato/a', 'Experto/a', 'Despistado/a'];

module.exports = { LOCATIONS: LOCATIONS, GENERIC_ROLES: GENERIC_ROLES };
