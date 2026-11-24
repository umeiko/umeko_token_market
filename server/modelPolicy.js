function parsed(value, fallback) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export const allowedModels = (value) => {
  const models = parsed(value, []);
  return Array.isArray(models) ? [...new Set(models.filter((model) => typeof model === 'string'))].slice(0, 100) : [];
};

export function modelAliases(value) {
  const aliases = parsed(value, {});
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return new Map();
  return new Map(Object.entries(aliases).filter(([, alias]) => typeof alias === 'string' && alias.trim()));
}

export function keyModels(key) {
  const allowed = allowedModels(key.allowed_models);
  const aliases = modelAliases(key.model_aliases);
  const names = new Map(allowed.map((name) => [name, aliases.get(name) || name]));
  return {
    restricted: allowed.length > 0,
    allowed: new Set(allowed),
    publicIds: names,
    routes: new Map([...names].map(([name, alias]) => [alias, name])),
  };
}
