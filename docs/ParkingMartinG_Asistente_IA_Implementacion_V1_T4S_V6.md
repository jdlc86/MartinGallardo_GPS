> **DOCUMENTO HISTÓRICO — NO NORMATIVO.** Describe una etapa anterior del diseño del Asistente IA. Para comportamiento vigente consultar `README.md`, `docs/ARCHITECTURE.md`, `docs/STABLE_RELEASE.md`, `docs/TEST_PLAN.md` y `docs/MAINTENANCE_AUDIT_2026-09-04.md`. Ante contradicción, prevalece la documentación vigente.

# ParkingMartin-G
## Asistente IA de asignación — Adenda V6: política T4S

**Continuación técnica de:**
- `docs/ParkingMartinG_Asistente_IA_Implementacion_V1.md`

Esta adenda corrige y sustituye, donde exista conflicto, cualquier tratamiento previo de T4S como nodo operativo de vehículo.

## 1. Decisión operativa definitiva

Para recogidas y entregas de vehículos, los únicos nodos operativos del aeropuerto son:

- `T1`
- `T2`
- `T3`
- `T4`

`T4S` **no es un nodo operativo del solver** porque el vehículo no se recoge ni se entrega físicamente en la terminal satélite.

El grafo terrestre de carretera queda formado por:

- `PARKING`
- `T1`
- `T2`
- `T3`
- `T4`

La lógica T4↔T4S por tren se elimina del optimizador de operarios y vehículos.

## 2. Normalización defensiva T4S → T4

Aunque T4S no debería llegar como punto operativo de una reserva, el backend debe ser tolerante a errores de entrada.

Si una tarea llega con terminal original `T4S`, el planificador aplica:

- `terminal_original = T4S`
- `terminal_operativa = T4`
- `requires_review = true`
- `review_reason = terminal_t4s_normalized`

La tarea sigue siendo planificable usando T4 como punto físico, pero la normalización **no es silenciosa**.

## 3. Mensaje obligatorio de revisión

La propuesta y el informe del operario deben incluir:

> ⚠️ Terminal original T4S normalizada a T4 para la operativa del vehículo. Revisar la reserva antes de ejecutar.

La misma incidencia queda disponible para el Admin dentro de la propuesta global mediante el bloque `reviews`.

## 4. Google Routes

Google Routes debe trabajar solo con los cinco nodos operativos:

- PARKING
- T1
- T2
- T3
- T4

T4S queda excluida de:

- resolución de coordenadas;
- matriz de carretera;
- TTL de rutas;
- anomalías de tráfico;
- cálculo de distancia y duración de coche.

Las coordenadas definitivas de esos cinco nodos se incorporarán cuando sean proporcionadas por el negocio. Hasta entonces se consideran pendientes; no se deben inventar coordenadas.

La API de Google Routes está habilitada según configuración del proyecto, pero la matriz no debe considerarse cerrada hasta disponer de las coordenadas verificadas.

## 5. Implementación desplegada

Edge Function:

- `reservation-ai-planner`
- versión desplegada: **v6**

Cambios principales de v6:

1. `nodes()` consulta solo `PARKING/T1/T2/T3/T4`.
2. `refresh_routes` calcula la matriz únicamente con esos cinco nodos.
3. `T4S` se normaliza a `T4` en el mapeo de tareas.
4. Se conserva la terminal original para trazabilidad.
5. Toda normalización genera `requires_review=true`.
6. Los informes individuales muestran la advertencia de revisión.
7. La propuesta devuelve `requires_review` y `reviews` para que el Admin pueda identificar incidencias.
8. Se elimina la lógica de tren T4↔T4S del grafo de movimientos entre terminales.

## 6. Estado de confirmación

La confirmación automática continúa bloqueada:

- `confirmation_enabled = false`
- `engine_status = physical_model_diagnostic_v1`

Esta decisión no cambia con la normalización de T4S. La activación de escritura automática dependerá de la validación global del solver físico y de las matrices de trayecto.

## 7. Regla de prevalencia

Ante cualquier contradicción entre documentos anteriores y esta adenda, para V1 prevalece:

`T4S no operativo → normalizar a T4 + advertencia + revisión humana`.
