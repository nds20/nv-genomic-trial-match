export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, totpSecret, ...rest } = user;
  return { ...rest, mfaEnrolled: Boolean(totpSecret) };
}
