export function neverCalledDecl(a) {
  const b = a + 1;
  return b * 2;
}

export const neverCalledArrow = (a) => {
  const b = a + 1;
  return b * 2;
};

export function called() {
  return 1;
}
