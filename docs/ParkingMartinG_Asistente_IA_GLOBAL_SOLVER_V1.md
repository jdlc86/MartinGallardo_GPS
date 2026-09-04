> **DOCUMENTO HISTÓRICO — NO NORMATIVO.** Describe una etapa anterior del diseño del Asistente IA. Para comportamiento vigente consultar `README.md`, `docs/ARCHITECTURE.md`, `docs/STABLE_RELEASE.md`, `docs/TEST_PLAN.md` y `docs/MAINTENANCE_AUDIT_2026-09-04.md`. Ante contradicción, prevalece la documentación vigente.

# ParkingMartin-G
## Asistente IA — Motor global de planificación V1

**Continuación de:**
- `docs/ParkingMartinG_Asistente_IA_Asignacion_Operarios.md`
- `docs/ParkingMartinG_Asistente_IA_Asignacion_Operarios_CONTINUACION.md`
- `docs/ParkingMartinG_Asistente_IA_Implementacion_V1.md`

Este documento registra el salto desde el heurístico físico inicial al motor global diagnóstico desplegado el 2 de septiembre de 2026.

## 1. Motor desplegado

Nueva Edge Function:

`reservation-ai-global-solver`

Versión inicial:

`v1`

Identificador de motor:

`global_search_v1`

Estado de configuración:

- `engine_status = global_search_v1_diagnostic`
- `confirmation_enabled = false`

La Mini App continúa utilizando `reservation-ai-planner` para `status`, permisos, Google Routes, rechazo y futura confirmación. Solo la acción `optimize` se redirige al motor global mediante `ai-dispatch-runtime.js`.

## 2. Objetivo

El motor deja de decidir primero el reparto y después intentar reparar los desplazamientos. Explora combinaciones de asignación de tareas y evalúa cada solución teniendo en cuenta conjuntamente:

- tareas manuales ya asignadas;
- tareas pendientes;
- operarios activos;
- posición física derivada de cada operación;
- necesidad de transporte Parking↔aeropuerto;
- asientos disponibles en vehículos de clientes;
- máximo un compañero adicional;
- movimientos entre terminales mediante lanzadera;
- carga de trabajo;
- factibilidad temporal.

Las asignaciones manuales se cargan como decisiones fijas y nunca se alteran.

## 3. Búsqueda global V1

Para cada tarea pendiente, el motor explora los operarios activos que pueden insertarla sin crear una incompatibilidad temporal dura con las tareas ya presentes en su secuencia.

Para horizontes pequeños utiliza una búsqueda amplia (`search_width` hasta 2500 estados). Para conjuntos mayores reduce el ancho de búsqueda para controlar coste computacional.

No se presenta todavía como OR-Tools/CP-SAT. Es un motor de búsqueda global propio utilizado como etapa diagnóstica para validar el modelo antes de sustituirlo o complementarlo con un solver matemático dedicado.

## 4. Evaluación de transporte de compañeros

Para cada solución candidata se construyen:

- `seats`: asiento logístico disponible en el trayecto obligatorio de cada vehículo de cliente;
- `needs`: necesidad de un operario de ir Parking→aeropuerto o aeropuerto→Parking.

Se aplica un emparejamiento global de necesidades y asientos.

Restricciones:

- conductor y compañero distintos;
- dirección compatible;
- máximo un compañero por coche;
- ningún desvío adicional del coche del cliente;
- compatibilidad temporal;
- posibilidad de completar por lanzadera cuando terminal de llegada y terminal objetivo difieren.

Una solución con necesidades sin cubrir se marca como no físicamente cerrada.

## 5. Función objetivo V1

Orden de penalización aproximado:

1. tareas que quedan sin asignación factible;
2. necesidades de transporte de operarios sin resolver;
3. coste de transbordos entre terminales;
4. desequilibrio de carga entre operarios.

La puntualidad crítica y sus márgenes permanecen en el modelo temporal y se seguirán refinando en la evolución hacia el solver matemático final.

## 6. T4S

T4S no es nodo operativo.

Si una reserva contiene T4S:

- `terminal_original = T4S`
- `terminal_operational = T4`
- `requires_review = true`
- `review_reason = terminal_t4s_normalized`

El informe muestra:

> ⚠️ Terminal original T4S normalizada a T4 para la operativa del vehículo. Revisar la reserva antes de ejecutar.

Google Routes utilizará únicamente:

`PARKING, T1, T2, T3, T4`

Las coordenadas definitivas quedan pendientes de ser aportadas por el negocio.

## 7. Conflictos en asignaciones manuales

Una asignación manual nunca se cambia, pero puede ser físicamente incompatible con otra asignación manual.

Se ha añadido una validación defensiva en `ai-dispatch-runtime.js` para detectar secuencias manuales imposibles en los casos directos que ya pueden demostrarse con los tiempos calculados.

Cuando se detecta:

- `physical_feasible = false`;
- se muestra `manual_assignment_physical_conflict`;
- se añade una advertencia al informe del operario;
- no se modifica ninguna asignación manual;
- la confirmación permanece bloqueada.

Caso real detectado durante la implementación: dos `delivery` manuales del mismo operario el 26-09-2026 están separadas por solo 8 minutos. Con un bloque operativo de 10 minutos y la necesidad de desplazamiento físico, esa secuencia debe revisarse manualmente.

Esta validación debe trasladarse también al backend del solver antes de habilitar confirmación automática; la comprobación frontend actual es defensa adicional, no debe convertirse en la única barrera futura.

## 8. Datos disponibles para prueba

En el horizonte de 31 días consultado el 2 de septiembre de 2026 existen:

- 4 tareas asignadas manualmente;
- 1 tarea sin asignar.

Esto permite empezar a probar el motor con datos reales sin crear reservas ficticias.

## 9. Seguridad

El motor global valida `writer_epoch` mediante el mismo mecanismo de Gestión de Reservas antes de optimizar.

No implementa un sistema de permisos paralelo.

La confirmación automática sigue deshabilitada, por lo que el motor global únicamente crea propuestas diagnósticas en `ai_dispatch_plans`.

## 10. Siguiente evolución

Antes de habilitar la ejecución automática faltan:

1. trasladar la detección de conflictos manuales al backend del motor global;
2. incorporar coordenadas verificadas de PARKING/T1/T2/T3/T4 y poblar Google Routes;
3. validar múltiples escenarios con varios operarios activos;
4. incorporar explícitamente las alternativas de retraso penalizado `pickup +5` y `delivery +10`;
5. comparar el motor global propio con OR-Tools/CP-SAT y decidir si el motor matemático sustituye o complementa esta etapa;
6. solo después activar `confirmation_enabled` y reutilizar `reservation-task-api` para aplicar la propuesta confirmada.
