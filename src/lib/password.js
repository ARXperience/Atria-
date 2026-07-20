// Política de contraseñas (§55.3). Devuelve un mensaje de error o null si es válida.
export function validatePassword(pw) {
  if (!pw || pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (!/[a-zA-Z]/.test(pw)) return 'La contraseña debe incluir al menos una letra.';
  if (!/[0-9]/.test(pw)) return 'La contraseña debe incluir al menos un número.';
  return null;
}
