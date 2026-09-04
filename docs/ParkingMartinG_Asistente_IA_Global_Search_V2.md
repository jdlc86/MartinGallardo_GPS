> **DOCUMENTO HISTÓRICO — NO NORMATIVO.** Describe una etapa anterior del diseño del Asistente IA. Para comportamiento vigente consultar `README.md`, `docs/ARCHITECTURE.md`, `docs/STABLE_RELEASE.md`, `docs/TEST_PLAN.md` y `docs/MAINTENANCE_AUDIT_2026-09-04.md`. Ante contradicción, prevalece la documentación vigente.

# ParkingMartin-G
## Asistente IA de asignación — Global Search V2

**Fecha:** 2 de septiembre de 2026

Este documento continúa y prevalece, en caso de conflicto, sobre las descripciones anteriores de los motores `physical_diagnostic_v1` y `global_search_v1`.

## 1. Estado actual

Motor de optimización diagnóstico:

`reservation-ai-global-solver` **v2**

Identificador:

`global_search_v2`

Estado configurado:

`global_search_v2_diagnostic`

La aplicación mantiene:

`confirmation_enabled = false`

Por tanto, el motor puede analizar y generar propuestas, pero todavía no puede aplicar automáticamente asignaciones.

## 2. Detección de conflictos manuales en backend

Las asignaciones manuales continúan siendo inmutables.

El backend analiza la secuencia física de cada operario que tenga tareas manuales fijadas. Si dos compromisos manuales consecutivos no pueden realizarse físicamente dentro de la secuencia modelada, devuelve:

`manual_assignment_physical_conflict`

El solver:

- no reasigna ninguna de esas tareas;
- no elimina ninguna asignación manual;
- no propone sustituir al operario;
- marca el plan como `physical_feasible=false`;
- informa al Admin y al operario afectado de que la secuencia manual requiere revisión.

La detección ya no depende del frontend. La Mini App únicamente representa el diagnóstico recibido del backend.

## 3. Ventanas temporales

La hora de reserva es `scheduled_at`.

Objetivo preferente:

`arrival = scheduled_at - 5 min`

El solver explora alternativas de llegada únicamente dentro de las ventanas aprobadas:

### Pickup

- preferente: `-5 min`;
- puntual: `0 min`;
- retraso excepcional: `+1 ... +5 min`;
- nunca puede proponer más de `+5 min`.

### Delivery

- preferente: `-5 min`;
- puntual: `0 min`;
- retraso excepcional: `+1 ... +10 min`;
- nunca puede proponer más de `+10 min`.

## 4. Penalización de retrasos

El retraso no se usa como una ampliación gratuita de factibilidad.

Las soluciones se penalizan en este orden:

1. llegada 5 min antes — objetivo;
2. llegada con menos margen / puntual — penalizada;
3. delivery con retraso permitido — penalización alta;
4. pickup con retraso permitido — penalización significativamente superior;
5. tarea sin asignar — penalización extrema.

En V2 la penalización por cada minuto tarde de `pickup` es deliberadamente superior a la de `delivery`, reflejando el riesgo de que el cliente pierda su vuelo.

Los informes señalan expresamente cuando la solución utiliza una llegada puntual sin margen o un retraso permitido.

## 5. Duración de la operación

Se mantienen `10 min` operativos por pickup/delivery.

Si el operario llega antes de la hora programada, la operación no se considera terminada antes simplemente por haber llegado pronto. La rutina se modela desde la hora programada.

Si llega tarde, la rutina comienza a partir de su llegada real y desplaza la disponibilidad posterior del operario.

Esto impide que el solver cree capacidad ficticia mediante llegadas tempranas o retrasos.

## 6. Búsqueda conjunta

Para cada tarea automática el motor explora conjuntamente:

- operario candidato;
- alternativa temporal permitida;
- compatibilidad con tareas anteriores/posteriores;
- posición física del operario;
- necesidades Parking↔aeropuerto;
- asientos disponibles en coches de cliente;
- lanzadera entre T1/T2/T3/T4;
- balance de carga.

La búsqueda utiliza beam search acotado para esta etapa diagnóstica. No debe confundirse todavía con OR-Tools/CP-SAT.

## 7. Transporte de compañeros

Se mantiene:

`max_logistics_passengers = 1`

El coche del cliente no se desvía para resolver logística. Solo se aprovecha el trayecto que el vehículo ya debe realizar.

Las ventanas de llegada de V2 también se incorporan al emparejamiento de compañeros, por lo que el solver puede valorar si una combinación sigue siendo posible usando una llegada puntual o excepcionalmente tardía.

## 8. T4S

T4S no es nodo operativo.

Entrada `T4S`:

`T4S → T4`

con:

- `requires_review=true`;
- `review_reason=terminal_t4s_normalized`;
- alerta visible en informe y propuesta.

## 9. Mini App

`docs/preview-modern/ai-dispatch-runtime.js` redirige únicamente `optimize` hacia `reservation-ai-global-solver`.

El resto continúa en `reservation-ai-planner`:

- permisos;
- `writer_epoch`;
- estado;
- Google Routes;
- rechazo;
- futura confirmación.

El frontend ya no determina por sí mismo si existe conflicto manual. Solo adapta los diagnósticos devueltos por backend al bloque visual de incidencias.

## 10. Parámetros verificados en Supabase

A fecha de esta versión:

- `target_early_minutes = 5`
- `pickup_max_late_minutes = 5`
- `delivery_max_late_minutes = 10`
- `operation_minutes = 10`
- `engine_status = global_search_v2_diagnostic`
- `confirmation_enabled = false`

## 11. Próximo paso antes de habilitar escritura

1. Recibir e introducir las coordenadas GPS verificadas de `PARKING`, `T1`, `T2`, `T3`, `T4`.
2. Poblar/validar la matriz Google Routes real.
3. Probar el solver con varios operarios activos simultáneamente para validar emparejamiento de compañeros.
4. Sustituir el beam search diagnóstico por OR-Tools/CP-SAT o validar formalmente una alternativa equivalente.
5. Implementar una prueba de confirmación en entorno controlado reutilizando `reservation-task-api`.
6. Solo después valorar `confirmation_enabled=true`.
