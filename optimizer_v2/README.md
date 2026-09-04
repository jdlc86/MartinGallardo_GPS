# Optimizer V2 — arquitectura de optimización física

Este directorio contiene el nuevo motor de optimización. No reutiliza el patrón legacy de «asignar -> reparar -> descartar».

## Objetivos

1. maximizar tareas atendidas;
2. garantizar factibilidad física completa;
3. integrar desplazamientos y acompañantes en el modelo, no como postproceso;
4. ejecutar fuera del request HTTP para eliminar el riesgo 546;
5. escalar desde el benchmark de 150 reservas / 300 tareas hasta la ventana de producción;
6. conservar un validador independiente del solver.

## Flujo

```text
Mini App
  -> reservation-optimization-jobs-v1 (enqueue, respuesta inmediata)
  -> optimization_jobs

optimizer-worker
  -> claim_next_optimization_job() con lease
  -> snapshot inmutable de tareas/config/rutas/workers
  -> grafo de transiciones físicas
  -> OR-Tools CP-SAT
  -> matching acoplado de acompañantes
  -> validador físico independiente
  -> ai_dispatch_plans
  -> complete_optimization_job()

Mini App
  -> status(job_id)
  -> muestra plan solo cuando status=succeeded
```

## Reglas de seguridad

- V6 permanece desplegado mientras V2 no supere los quality gates.
- V2 nunca confirma ni escribe asignaciones operativas durante pruebas; genera propuestas.
- Un plan no puede marcarse `physical_feasible=true` si el validador independiente devuelve errores.
- Un job usa snapshot de entrada. Cambios posteriores en tareas/versiones invalidan la aplicación del plan.
- El worker usa service-role solo en servidor; nunca en Mini App.
- `optimization_jobs` y `optimization_job_events` tienen RLS y no son accesibles directamente por clientes.
- Los jobs se reclaman con `FOR UPDATE SKIP LOCKED`, lease y heartbeat. Un worker muerto no bloquea la cola indefinidamente.
- Reintentos son acotados e idempotentes.

## Estrategia algorítmica

El núcleo se modela como una red temporal de tareas con horarios fijos:

- cada tarea tiene nodo inicial, nodo final, inicio operativo y fin operativo;
- los arcos representan sucesiones físicamente posibles;
- `same_location`, `terminal_transfer` y `shift_reset` son arcos autónomos;
- `ride_out` / `ride_in` son arcos que requieren un asiento compatible de otra tarea asignada;
- los acompañamientos se modelan como variables acopladas, con capacidad del vehículo;
- las tareas manuales se fijan al operario indicado;
- la primera prioridad del objetivo es maximizar cobertura, y las preferencias operativas se optimizan después.

El solver devuelve únicamente decisiones estructuradas. El texto del plan se genera después a partir del contrato canónico de movimientos.

## Función objetivo lexicográfica

Orden de prioridad:

1. maximizar tareas cubiertas;
2. cero violaciones físicas (hard constraints, no penalización blanda);
3. minimizar inicios/reinicios de jornada innecesarios;
4. minimizar minutos de desplazamiento sin coche cliente;
5. minimizar lanzaderas;
6. minimizar acompañamientos cuando no aportan cobertura;
7. minimizar tiempos muertos;
8. equilibrar carga entre operarios.

La prioridad 1 se implementa con un peso dominante respecto al resto para que una mejora cosmética nunca sacrifique una tarea realizable.

## Quality gates antes de activar V2

Benchmark fijo: Excel `150 reservas / 3 días` ya utilizado en pruebas.

V2 no sustituye V6 hasta cumplir simultáneamente:

- 0 errores del validador físico;
- cobertura >= V6;
- ninguna tarea manual alterada;
- todos los acompañamientos tienen conductor/asiento/tiempos coherentes;
- determinismo con semilla fija;
- no se produce 546 porque el cálculo no corre en Edge Function;
- cancelación y recuperación de worker muerto verificadas;
- métricas de tiempo/memoria persistidas en el job.

## Ejecución local

```bash
cd optimizer_v2
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
pytest
python -m parking_optimizer.worker
```

Variables requeridas por el worker:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPTIMIZER_WORKER_ID` (opcional; se genera uno si no existe)

No se necesita API key para OR-Tools. Google Routes continúa alimentando `ai_dispatch_route_matrix` mediante el mecanismo existente.


## Estado de fases del algoritmo

### Fase 1 — COMPLETADA: Back-Forward Fast / Optimal

La planificación principal queda consolidada como una fase independiente y estable:

- línea temporal continua 24/7; no existen fronteras rígidas por día;
- ventana rolling-horizon por defecto de 1440 min y solape de 360 min;
- `fast`: selecciona como ancla la ventana de mayor densidad de operaciones;
- `optimal`: evalúa ventanas candidatas por cobertura/factibilidad;
- ambos modos utilizan exactamente el mismo motor forward/backward y el mismo stitching continuo;
- descansos y duraciones máximas dependen del modo de trabajo;
- tras cumplir descanso, una nueva jornada puede comenzar en PARKING o en cualquier terminal;
- acompañamientos y coche de empresa/lanzadera forman parte del modelo físico;
- la solución final debe pasar `validate_solution()`;
- la auditoría conservadora de no asignadas forma parte del cierre de Fase 1, pero solo inserta una operación cuando la inserción directa queda validada.

El entry point público `solve()` ejecuta exclusivamente esta Fase 1. También está disponible explícitamente como `solve_phase1()`.

Benchmark consolidado de referencia antes de introducir la Fase 2:

- Fast: 221/300 = 73,67 %, 0 errores físicos;
- Optimal: 223/300 = 74,33 %, 0 errores físicos.

Las operaciones no demostradas como insertables permanecen como `not_proven`; no se etiquetan como imposibles.

### Fase 2 — EXPERIMENTAL: reoptimización logística local

La reoptimización de los `not_proven` queda separada del algoritmo principal y se invoca únicamente mediante `run_phase2_reoptimization()`.

Reglas de aceptación:

- la solución de Fase 1 es el baseline de score;
- la operación auditada se fuerza dentro del subproblema;
- se permiten mejoras reales y swaps seguros;
- nunca se acepta `coverage_new < coverage_old`;
- toda propuesta debe reconstruir una solución global y pasar `validate_solution()` con 0 errores;
- si no se demuestra una reparación válida, la operación continúa como `not_proven`.

La Fase 2 no forma parte del benchmark de aceptación de Fast/Optimal ni de su tiempo de ejecución.
