# Plan de pruebas

## Objetivo

Permitir que Codex valide el sistema sin depender de múltiples personas reales usando Telegram.

La estrategia combina:

1. tests unitarios;
2. tests de integración con Supabase;
3. simulación de updates Telegram;
4. smoke test manual mínimo con el bot real.

## 1. Pirámide de pruebas

### Unitarias

Funciones puras:

- normalización de matrícula;
- parseo de comandos;
- validación de roles;
- transición de estados;
- evaluación de precisión GPS;
- construcción de botones/menús;
- validación de callback data.

### Integración

Probar contra Supabase local/dev:

- CRUD controlado;
- constraints;
- transiciones;
- idempotencia;
- RLS donde aplique;
- Storage privado.

### Webhook simulado

Enviar payloads equivalentes a Telegram hacia el handler o función extraída, sin necesidad de cuentas adicionales.

### Smoke real

Solo para confirmar integración externa:

- `/start`;
- un callback inline;
- una foto;
- una ubicación.

No repetir manualmente todos los casos que cubre la suite.

---

## 2. Fixtures Telegram

Crear builders para:

```ts
makeMessageUpdate({
  updateId,
  telegramUserId,
  text,
  username,
  firstName,
})

makeCallbackUpdate({
  updateId,
  telegramUserId,
  data,
  chatId,
  messageId,
})

makeLocationUpdate(...)
makePhotoUpdate(...)
```

Nunca usar IDs de personas reales en fixtures. Usar rangos ficticios documentados.

---

## 3. Matriz de control de acceso

| Caso | Estado inicial | Acción | Resultado esperado |
|---|---|---|---|
| desconocido | sin usuario/solicitud | `/start` | solicitud `pending` |
| pending repetido | pending | `/start` | sigue pending, actualiza last_seen/attempts |
| rechazado repetido | rejected | `/start` | sigue rejected |
| aprobar | pending | callback approve | worker activo + approved |
| rechazar | pending | callback reject | rejected, sin acceso |
| doble aprobar | approved | callback approve | sin duplicados |
| doble rechazar | rejected | callback reject | sin transición inválida |
| operario pulsa approve | pending | callback operario | 403 lógico/no autorizado |
| admin bloquea operario | activo | bloquear | acceso denegado inmediato |
| admin reactiva | inactivo | reactivar | acceso restaurado |
| admin intenta bloquearse | admin activo | bloquear self | denegado |

---

## 4. Matriz de vehículos

### Matrícula

Probar equivalencias:

```text
1234 ABC
1234-ABC
1234abc
 1234 ABC 
```

Todas deben producir el mismo `normalized_plate` si esa es la regla implementada.

Probar:

- vacío;
- caracteres no esperados;
- longitud absurda;
- matrícula duplicada.

### Dejar coche

Casos:

- nuevo vehículo + GPS bueno;
- nuevo + GPS malo + sector manual;
- nuevo + GPS malo + texto;
- parking sin sectores + texto;
- vehículo ya parked -> confirmación;
- usuario cancela en cada paso;
- retry del último update -> no duplica evento;
- foto subida dos veces/retry -> no duplica metadata si existe dedupe.

### Retirar

- vehículo parked -> retrieve correcto;
- matrícula inexistente;
- vehículo ya retrieved;
- doble callback confirmar;
- historial queda intacto.

---

## 5. GPS

Dado threshold 15 m:

| accuracy | esperado |
|---:|---|
| 3 | good |
| 15 | good |
| 15.01 | poor |
| 40 | poor |
| null | no inventar calidad; solicitar fallback |

Probar cambio de threshold en configuración.

Probar que la selección manual conserva la accuracy original cuando exista.

---

## 6. Configuración

Casos:

- operario intenta configurar -> denegado;
- admin entra sin escribir `Configurar` -> no modifica;
- admin confirma `Configurar` -> modo permitido;
- crear sector;
- código duplicado;
- editar sector;
- desactivar sector;
- sector usado históricamente -> no borrado destructivo;
- auditoría registra actor.

---

## 7. Fotos

Casos:

- upload válido;
- MIME/tamaño no permitido según política implementada;
- Storage falla después de crear metadata;
- DB falla después de upload -> cleanup/registro recuperable;
- acceso público directo -> debe fallar;
- signed URL -> expira;
- vehículo retirado -> fotos siguen accesibles para autorizado.

---

## 8. Idempotencia

Es obligatorio probar reintentos de Telegram.

Simular exactamente el mismo `update_id` dos veces para:

- `/start` unknown;
- approve;
- reject;
- park;
- retrieve;
- photo.

Resultado: máximo un efecto de dominio.

---

## 9. Concurrencia

Casos útiles:

- dos admins intentan aprobar la misma solicitud;
- dos operarios intentan retirar el mismo vehículo;
- dos actualizaciones de ubicación casi simultáneas;
- reactivación y bloqueo concurrentes.

Usar constraints/transacciones para que el estado final sea determinista o, como mínimo, consistente.

---

## 10. Seguridad

Automatizar comprobaciones:

- ningún secreto en repo;
- service role no aparece en código cliente;
- bucket privado;
- RLS habilitado en tablas expuestas;
- callbacks admin verifican actor en DB;
- username no se usa como identidad;
- `telegram_user_id` proviene de `from.id`, no de texto escrito;
- webhook rechaza secret header incorrecto;
- endpoint no procesa payload malformado como operación válida.

---

## 11. Pruebas de carga razonables

No se necesita stress masivo para MVP.

Generar dataset sintético aproximado:

- 30 días;
- 150 vehículos/día;
- varios eventos por vehículo;
- fotos como metadata simulada.

Medir búsquedas típicas:

- matrícula exacta;
- vehículos parked;
- historial de vehículo;
- últimas operaciones de un operario.

Objetivo: detectar consultas sin índice o N+1, no demostrar escalado a millones de TPS.

---

## 12. Smoke test real de release

Antes de un despliegue considerado estable:

1. admin `/start`;
2. usuario de prueba autorizado o simulación controlada de solicitud;
3. botón Aceptar/Rechazar;
4. flujo de dejar coche con matrícula ficticia claramente marcada TEST;
5. ubicación real o controlada;
6. foto de prueba;
7. búsqueda;
8. retirada;
9. cleanup de datos TEST si corresponde sin borrar auditoría necesaria.

Nunca usar vehículos reales para pruebas automatizadas destructivas.

---

## 13. Definition of Done de pruebas

Una feature puede considerarse lista cuando:

- happy path cubierto;
- al menos los errores previsibles cubiertos;
- retry/idempotencia cubierta si tiene efecto de escritura;
- permisos cubiertos;
- migración verificada;
- no exige una segunda persona real para ejecutar CI.
