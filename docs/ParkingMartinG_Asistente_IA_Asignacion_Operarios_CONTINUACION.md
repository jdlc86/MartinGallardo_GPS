# ParkingMartin-G
## Asistente IA para asignación eficiente de operarios — Continuación

**Documento de continuación de:** `docs/ParkingMartinG_Asistente_IA_Asignacion_Operarios.md`

Este documento continúa la especificación funcional y técnica del Asistente IA de planificación. Debe leerse conjuntamente con dicho documento.

> **Decisión V1 posterior y prevalente:** para la primera versión del optimizador se simplifica la elegibilidad. Los candidatos automáticos son los **operarios activos**. No se utilizarán niveles `BAJO/MEDIO/EXPERTO` ni clasificación `MARCA → GAMA` para decidir asignaciones automáticas en V1. Las tareas que el Admin considere críticas o que requieran una persona concreta se asignarán manualmente antes de optimizar; esas asignaciones quedan fijadas y el solver planifica alrededor de ellas. Esta decisión sustituye, para V1, las reglas anteriores de experiencia/gama donde entren en conflicto.

## 18. Matriz dinámica de trayectos mediante Google Routes

### 18.1 Objetivo
Google Routes no se utilizará para consultar individualmente cada reserva. Su función será calibrar periódicamente la matriz logística de carretera, capturar diferencias por franja y detectar anomalías puntuales (obras, cortes, desvíos o congestión excepcional).

`Solicitud de optimización → comprobar vigencia de matriz → Google Routes si procede → matriz dinámica → OR-Tools → propuesta → IA → confirmación Admin`

### 18.2 Nodos operativos
Como mínimo: Parking, T1, T2, T3, T4 y T4S. La matriz es dirigida: `A → B` y `B → A` pueden diferir.

### 18.3 Franjas horarias
| Franja | Horario Europe/Madrid |
| --- | --- |
| `MADRUGADA` | 00:00–05:59 |
| `PUNTA_MANANA` | 06:00–09:59 |
| `VALLE_DIA` | 10:00–15:59 |
| `PUNTA_TARDE` | 16:00–19:59 |
| `NOCHE` | 20:00–23:59 |

Las franjas son configurables y persistentes, no rígidas en el solver.

### 18.4 Datos por origen, destino y franja
Campos conceptuales: `origin`, `destination`, `time_band`, `distance_m`, `baseline_duration_s`, `current_duration_s`, `deviation_pct`, `fetched_at`, `source`, `is_anomaly`.

### 18.5 Actualización y caché
No se harán llamadas por cada reserva. Se agrupan y reutilizan por nodo/franja. Antes de optimizar se comprueba vigencia y se refresca solo lo necesario. Con 6 nodos hay 30 trayectos dirigidos útiles y, con 5 franjas, hasta 150 combinaciones antes de caché.

### 18.6 Anomalías
Se compara el tiempo actualizado con el baseline de ese trayecto/franja. El umbral de anomalía será configurable y el solver utilizará el dato actualizado cuando proceda.

### 18.7 Kilometraje
`km máximos planificables = km lógicos estimados del servicio + 4 km de margen operativo`

El odómetro fotografiado no forma parte del cálculo del optimizador.

## 19. Movilidad entre terminales

### 19.1 Bus Tránsito gratuito T1/T2/T3/T4
Opción prioritaria cuando sea temporalmente viable.

- hacia T4: `T1 → T2 → T4`
- desde T4: `T4 → T3 → T2 → T1`
- 06:00–22:00: aproximadamente cada 5 min
- 22:00–06:00: aproximadamente cada 20 min

| Origen | Destino | Tiempo bus aproximado |
| --- | --- | ---: |
| T1 | T2 | 2 min |
| T1 | T4 | 10 min |
| T2 | T4 | 8 min |
| T4 | T3 | 8 min |
| T4 | T2 | 10 min |
| T4 | T1 | 15 min |

La matriz es dirigida; no se inventa simetría.

### 19.2 Acceso y espera
Para T1/T2/T3/T4: **5 min por defecto** desde punto operativo hasta parada. La espera no es constante: se deriva de frecuencia/servicio y su incertidumbre se incorpora al trayecto.

### 19.3 T4 ↔ T4S
Medio distinto: tren automático.

- acceso punto operativo → tren: **10 min**;
- sustituye los 5 min estándar;
- trayecto aproximado: 5 min;
- espera variable según frecuencia e incorporada a la incertidumbre.

## 20. Tiempo operativo
Cada `pickup` y `delivery` bloquea **10 min operativos**. Durante ese tiempo el operario no está disponible para otra tarea/desplazamiento.

## 21. Transporte de compañeros
Restricción dura: `max_logistics_passengers_per_customer_vehicle = 1`.

Además del conductor, máximo un compañero adicional por logística. Debe respetar ventanas temporales, kilometraje y coherencia de rutas y reflejarse en ambos itinerarios.

## 22. Elegibilidad de operarios y asignaciones manuales — V1

### 22.1 Disponibilidad
Para V1, el conjunto de candidatos del solver está formado exclusivamente por **operarios activos** en el sistema.

- Operario activo → candidato automático.
- Operario desactivado → excluido automáticamente.
- Un usuario `root` o `admin` no se considera chófer por el mero hecho de tener ese rol; solo entra en el conjunto de candidatos si el modelo actual del sistema lo identifica además como operario activo.

No se introduce en V1 un calendario/turno adicional independiente de la condición de operario activo. Si posteriormente el negocio necesita turnos, vacaciones o disponibilidades parciales, se ampliará el modelo.

### 22.2 Todos los operarios activos son equivalentes para el reparto automático
En V1 el solver **no diferencia chóferes por experiencia**. Se pospone el uso de `BAJO`, `MEDIO` y `EXPERTO` como restricciones de asignación.

### 22.3 Todos los vehículos son equivalentes para el reparto automático
En V1 el solver **no utiliza la gama/marca del vehículo para decidir qué operario puede conducirlo**. Se pospone la regla automática `GAMA_ALTA → EXPERTO` y el catálogo `MARCA → GAMA` como criterio de elegibilidad.

Esto no elimina la posibilidad futura de reintroducir experiencia y gama; simplemente quedan fuera del problema de optimización V1.

### 22.4 Operaciones críticas o especiales: asignación manual previa
El Admin conserva la capacidad de asignar manualmente cualquier tarea antes de ejecutar el optimizador. Esta es la vía V1 para reservar operaciones críticas, vehículos especiales o cualquier situación que por criterio humano deba realizar una persona concreta.

El solver debe distinguir:

- **tareas ya asignadas manualmente** → decisiones fijas que se respetan;
- **tareas sin asignar** → conjunto que el solver puede repartir entre operarios activos.

El optimizador no debe deshacer, sustituir ni reinterpretar silenciosamente una asignación manual preexistente. Debe planificar el resto de la logística alrededor de ella.

La asignación manual también ocupa tiempo y posición dentro del itinerario del operario, por lo que debe incluirse al comprobar factibilidad de las tareas automáticas posteriores/anteriores.

### 22.5 Reoptimización de una asignación manual
Por defecto, una asignación manual queda bloqueada para el solver. Solo podrá reconsiderarse si el Admin solicita de forma explícita una modalidad futura de reoptimización que permita modificar tareas previamente fijadas.

## 23. Política de puntualidad, criticidad e incertidumbre

### 23.1 Diferencia entre pickup y delivery
- `pickup`: operación crítica; un retraso puede contribuir a que el cliente pierda el vuelo.
- `delivery`: importante pero más flexible; el retraso genera espera, normalmente sin riesgo de perder un vuelo.

Esta asimetría afecta a la función objetivo temporal, pero **no reintroduce diferencias de experiencia entre chóferes**.

### 23.2 Política normal
Objetivo para cualquier tarea: `target_arrival = scheduled_time - 5 min`.

### 23.3 Retrasos máximos tolerables
| Operación | Objetivo | Retraso máximo tolerable |
| --- | --- | ---: |
| `pickup` | llegar 5 min antes | **5 min** después de la hora programada |
| `delivery` | llegar 5 min antes | **10 min** después de la hora programada |

Son escenarios no deseados y deben ser la peor opción. Superarlos hace la planificación automática no factible salvo futura excepción explícita del Admin.

### 23.4 Jerarquía temporal
1. No superar retraso máximo de `pickup`.
2. No superar retraso máximo de `delivery`.
3. Evitar cualquier retraso en `pickup`.
4. Evitar retrasos en `delivery`.
5. Buscar llegar al menos 5 min antes.
6. Después optimizar tiempos muertos, carga, kilómetros y demás objetivos blandos.

### 23.5 Propagación de incertidumbre
No basta sumar tiempos medios. Se considera incertidumbre acumulada por tráfico/Google Routes, espera del Bus Tránsito, espera del tren T4↔T4S, accesos, dependencias con compañeros y márgenes operativos configurables.

### 23.6 Hora recomendada de salida
El resultado debe incluir la hora recomendada de salida desde Parking o cualquier origen:

`hora_salida_recomendada = target_arrival - tiempo_estimado_total - margen_por_incertidumbre`

El margen depende del itinerario, no es una constante universal.

### 23.7 Itinerario robusto
La solución óptima no es necesariamente la de menor tiempo medio. Debe reducir el riesgo de incumplimiento, especialmente en `pickup`.

## 24. Principio de uso de Google
Google actúa como **sensor externo de calibración logística**, no como dependencia por cada tarea individual. Esto reduce coste y llamadas mientras permite capturar diferencias por horario y anomalías de la red viaria.
