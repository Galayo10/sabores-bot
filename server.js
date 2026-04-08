import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import bcrypt from 'bcrypt';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper as axiosCookieJarSupport } from 'axios-cookiejar-support';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Habilita cookies en axios
axiosCookieJarSupport(axios);

// -------- Woo config --------
const WP_BASE = (process.env.WP_BASE_URL || '').replace(/\/+$/,'');
if (!WP_BASE) console.warn('⚠️ Falta WP_BASE_URL en .env (https://tu-dominio.com)');

// Woo REST (productos/stock/búsquedas)
const wooRest = axios.create({
  baseURL: WP_BASE + '/wp-json/wc/v3',
  auth: { username: process.env.WC_CONSUMER_KEY || '', password: process.env.WC_CONSUMER_SECRET || '' },
  timeout: 10000
});

// Woo Store API (carrito) — sin auth, con cookie (CookieJar)
function makeStoreApi(jar) {
  return axios.create({
    baseURL: WP_BASE + '/wp-json/wc/store/v1',
    jar, withCredentials: true, timeout: 10000,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ------------------------- Middlewares base -------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Helmet con CSP compatible (permite iframe para el widget)
app.use(
  helmet({
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "frame-ancestors": ["*"], // permite embeber como widget
      },
    },
  })
);

// Sesión (para panel y auth mínima)
app.set('trust proxy', 1);
app.use(
  session({
    name: 'sgsid',
    secret: process.env.SESSION_SECRET || 'devsecret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false, // true con HTTPS real
    },
  })
);

// Rate limit en /login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// ------------------------- Helpers Auth -------------------------
function requireAuth(req, res, next) {
  if (req.session?.auth === true) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'UNAUTHORIZED' });
  return res.redirect('/login');
}

async function checkPassword(plain) {
  if (process.env.ADMIN_HASH) {
    try { return await bcrypt.compare(plain, process.env.ADMIN_HASH); }
    catch { return false; }
  }
  if (process.env.ADMIN_PASS) return plain === process.env.ADMIN_PASS;
  return false;
}

// ------------------------- Vistas login / logout -------------------------
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const okUser = username === (process.env.ADMIN_USER || 'admin');
  const okPass = await checkPassword(password || '');
  if (okUser && okPass) {
    req.session.auth = true;
    return res.redirect('/admin');
  }
  return res.redirect('/login?e=1');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ------------------------- Rutas públicas (chat & embed) -------------------------
app.get('/embed', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'embed.html'));
});

// Ruta explícita del panel (protegida)
app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ------------------------- Carga de conocimiento -------------------------
function safeRead(filePath, fallback = '') {
  try { return fs.readFileSync(filePath, 'utf-8'); }
  catch { return fallback; }
}

const manualEmpresa = safeRead(path.join(__dirname, 'info.txt'), '');

// Productos desde Excel (si falta, arranca con lista vacía)
let productos = [];
try {
  const workbook = XLSX.readFile(path.join(__dirname, 'productos.xlsx'));
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  productos = XLSX.utils.sheet_to_json(sheet);
} catch (e) {
  console.warn('⚠️  No se pudo leer productos.xlsx. Continúo con productos = [].');
}

const productosTexto = productos
  .map(p => `${p.Producto} (${p.Tipo}) - ${p.Descripción}, Precio: ${p.Precio}€`)
  .join('\n');

// ------------------------- Utils NLP & Analítica -------------------------
const normaliza = s =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();

const STOPWORDS = new Set([
  'mermelada','mermeladas','licor','licores','membrillo','membrillos','vinagre','vinagres',
  'de','del','la','el','los','las','y','en','con','sin','para','por','sobre',
  'me','puede','puedes','podeis','podéis','hablar','informacion','información',
  'una','un','unos','unas','que','hay','teneis','tenéis','tieneis'
]);

const tokens = (s) =>
  normaliza(s)
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .split(/\s+/)
    .filter(t => t && !STOPWORDS.has(t));

function singular(t) {
  if (t.endsWith('es') && !t.endsWith('ces')) return t.slice(0, -2);
  if (t.endsWith('s') && t.length > 3) return t.slice(0, -1);
  return t;
}

// ---- Categorías y helpers ----
const CATEGORIES = ['mermelada','vinagre','licor','membrillo'];
const CATEGORY_PRIORITY = ['mermelada','vinagre','licor','membrillo'];

function detectCategory(text) {
  const t = normaliza(text);
  for (const c of CATEGORIES) {
    if (t.includes(c)) return c;
  }
  return null;
}

function getProductCategory(p) {
  const name = normaliza(p.Producto || '');
  const tipo = normaliza(p.Tipo || '');
  if (name.includes('mermelada') || tipo.includes('mermelada')) return 'mermelada';
  if (name.includes('vinagre')   || tipo.includes('vinagre'))   return 'vinagre';
  if (name.includes('licor')     || tipo.includes('licor'))     return 'licor';
  if (name.includes('membrillo') || tipo.includes('membrillo')) return 'membrillo';
  return 'mermelada'; // fallback sensato
}

// Palabras “ruido” que no deben pesar al indexar nombres de producto
const NAME_STOPWORDS = new Set([
  'extra','artesana','artesano','casera','casa','alonso','sabores','guijo',
  'de','del','la','el','los','las'
]);

// Tokenizador para nombres de producto (limpia 250g, 500ml, 1l...)
function nameTokens(name) {
  const cleaned = normaliza(name).replace(/\b\d+(?:\.\d+)?\s*(?:g|ml|l)\b/g, ' ');
  return cleaned
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .split(/\s+/)
    .filter(t => t && !STOPWORDS.has(t) && !NAME_STOPWORDS.has(t));
}

// Léxico de sabores (para "no disponibles")
const FLAVORS = new Set([
  'fresa','fresas','frambuesa','frambuesas','cereza','cerezas','arandano','arandanos','arándano','arándanos',
  'mora','moras','higo','higos','melocoton','melocotones','albaricoque','albaricoques','ciruela','ciruelas',
  'manzana','manzanas','pera','peras','membrillo','membrillos','limon','limones','naranja','naranjas',
  'mandarina','mandarinas','pomelo','pomelos','kiwi','kiwis','uva','uvas','mango','mangos',
  'pina','piña','pinas','piñas','coco','cocos','granada','granadas','maracuya','maracuyas',
  'grosella','grosellas','higo chumbo','higos chumbos','arandano rojo','arandanos rojos',
  'frutos del bosque','frutos bosque','castana','castañas','castana','castañas'
]);

function flavorTokensFrom(texto) {
  const ts = tokens(texto);
  return ts
    .map(singular)
    .filter(t => FLAVORS.has(t) || FLAVORS.has(`${t}s`) || FLAVORS.has(`${t}es`));
}

// ---------- Índices del catálogo (categoria-aware) ----------
const productKeywords = productos.map(p => {
  const name = normaliza(p.Producto || '');
  const kws  = nameTokens(name);
  const kwsSing = kws.map(singular);
  const category = getProductCategory(p);
  return { p, kws, kwsSing, name, category };
});

const catalogFlavorSet = new Set(productKeywords.flatMap(x => x.kwsSing));

const DISPLAY_BY_FLAVOR = new Map();         // 'higo' -> 'Mermelada de Higo'
const DISPLAY_BY_FLAVOR_AND_CAT = new Map(); // 'mermelada|higo' -> 'Mermelada de Higo'

for (const it of productKeywords) {
  for (const kw of it.kwsSing) {
    if (!DISPLAY_BY_FLAVOR.has(kw)) {
      DISPLAY_BY_FLAVOR.set(kw, it.p.Producto);
    }
    const key = `${it.category}|${kw}`;
    if (!DISPLAY_BY_FLAVOR_AND_CAT.has(key)) {
      DISPLAY_BY_FLAVOR_AND_CAT.set(key, it.p.Producto);
    }
  }
}

function pickDisplayByPriority(flavor) {
  for (const cat of CATEGORY_PRIORITY) {
    const key = `${cat}|${flavor}`;
    if (DISPLAY_BY_FLAVOR_AND_CAT.has(key)) return DISPLAY_BY_FLAVOR_AND_CAT.get(key);
  }
  return DISPLAY_BY_FLAVOR.get(flavor) || null;
}

// Coincidencia estricta de producto (respeta categoría y da peso a sabores)
function findCandidate(userText) {
  const kwsUserSing = tokens(userText).map(singular);
  if (kwsUserSing.length === 0) return null;

  const wantedCat = detectCategory(userText); // puede ser null
  let best = null;
  let bestScore = -1;

  for (const it of productKeywords) {
    if (wantedCat && it.category !== wantedCat) continue;

    if (normaliza(userText) === it.name) return it.p;

    const overlapAll    = it.kwsSing.filter(k => kwsUserSing.includes(k)).length;
    const overlapFlavor = it.kwsSing.filter(k =>
      kwsUserSing.includes(k) && (FLAVORS.has(k) || FLAVORS.has(`${k}s`) || FLAVORS.has(`${k}es`))
    ).length;

    // si NO hay ninguna coincidencia, ignora este producto
    if (overlapAll === 0 && overlapFlavor === 0) continue;

    const score = overlapFlavor * 10 + (overlapAll - overlapFlavor);

    if (score > bestScore) {
      bestScore = score;
      best = it.p;
    } else if (score === bestScore && best) {
      const catA = it.category;
      const catB = getProductCategory(best);
      const pa = CATEGORY_PRIORITY.indexOf(catA);
      const pb = CATEGORY_PRIORITY.indexOf(catB);
      if (pa !== -1 && pb !== -1 && pa < pb) {
        best = it.p;
      } else if (pa === pb && it.name.length > normaliza(best.Producto).length) {
        best = it.p;
      }
    }
  }

  return best || null;
}

// ------------------------- Carrito interno (solo queda para compat) -------------------------
const carritos = Object.create(null); // ya NO lo usamos para Woo, pero lo dejamos para no romper nada

function getCarrito(sessionId) {
  if (!carritos[sessionId]) carritos[sessionId] = { items: [], ts: Date.now() };
  return carritos[sessionId];
}
function vaciarCarrito(sessionId) {
  carritos[sessionId] = { items: [], ts: Date.now() };
}
function addToCart(sessionId, prod, cantidad) {
  const c = getCarrito(sessionId);
  const key = normaliza(prod.Producto);
  const existente = c.items.find(it => normaliza(it.producto.Producto) === key);
  if (existente) existente.cantidad += cantidad;
  else c.items.push({ producto: prod, cantidad, precio: Number(prod.Precio) || 0 });
  return c;
}
function totalCarrito(cart) {
  return cart.items.reduce((acc, it) => acc + it.cantidad * (Number(it.precio) || 0), 0);
}
function resumenCarrito(cart) {
  if (!cart.items.length) return 'El carrito está vacío.';
  const lineas = cart.items.map(it => `• ${it.cantidad} × ${it.producto.Producto} — ${it.precio}€ c/u`);
  lineas.push(`Total: ${totalCarrito(cart).toFixed(2)}€`);
  return lineas.join('\n');
}

// -------- Woo: CookieJar por sesión + estado de variación pendiente --------
const wooJars = Object.create(null); // { sessionId: CookieJar }
function ensureJar(sessionId) {
  if (!wooJars[sessionId]) wooJars[sessionId] = new CookieJar();
  return wooJars[sessionId];
}

const pendingVariation = Object.create(null); 
// pendingVariation[sessionId] = { productId, productName, options:[{label, attrKey, value, variation_id}], qty }

// ------------------------- Historial persistente -------------------------
const DATA_DIR = path.join(__dirname, 'data');
const MSG_FILE = path.join(DATA_DIR, 'messages.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(MSG_FILE)) fs.writeFileSync(MSG_FILE, '[]', 'utf-8');

function loadMessages() {
  try { return JSON.parse(fs.readFileSync(MSG_FILE, 'utf-8')); }
  catch { return []; }
}
function saveMessages(arr) {
  fs.writeFileSync(MSG_FILE, JSON.stringify(arr, null, 2), 'utf-8');
}
function appendMessage(entry) {
  try {
    const all = loadMessages();
    all.push(entry);
    if (all.length > 50000) all.splice(0, all.length - 50000);
    saveMessages(all);
  } catch (e) {
    console.error('❌ Error guardando messages.json:', e);
  }
}

// ------------------------- OpenAI -------------------------
if (!process.env.OPENAI_API_KEY) {
  console.warn('⚠️  Falta OPENAI_API_KEY en .env. Las respuestas de IA no funcionarán.');
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ------------------------- Helpers de fecha -------------------------
function inRange(tsISO, from, to) {
  if (!tsISO) return false;
  const d = tsISO.slice(0, 10); // YYYY-MM-DD
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

// ------------------------- Woo helpers -------------------------

// Busca productos por nombre (aprox) y devuelve el más parecido
async function wooFindProductByName(q) {
  const { data } = await wooRest.get('/products', { params: {
    search: q, status: 'publish', per_page: 10
  }});
  if (!Array.isArray(data) || !data.length) return null;

  // Score sencillo por coincidencia en el nombre
  const n = normaliza(q);
  data.sort((a,b) => {
    const na = normaliza(a.name || '');
    const nb = normaliza(b.name || '');
    const sa = (na.includes(n) ? 2 : 0) + (n.includes(na) ? 1 : 0);
    const sb = (nb.includes(n) ? 2 : 0) + (n.includes(nb) ? 1 : 0);
    return sb - sa;
  });
  return data[0];
}

// Comprueba stock (para simples; si hay variables, pedimos seleccionar)
function wooCheckStock(prod, qty) {
  if (prod.type === 'variable') return { ok: false, reason: 'variable' };
  if (prod.stock_status !== 'instock') return { ok: false, reason: 'out' };
  if (prod.manage_stock && typeof prod.stock_quantity === 'number' && prod.stock_quantity < qty) {
    return { ok: false, reason: 'low', available: prod.stock_quantity };
  }
  return { ok: true };
}

// Crea/asegura carrito en Store API (la cookie vive en el jar)
async function wooEnsureCart(sessionId) {
  const jar = ensureJar(sessionId);
  const store = makeStoreApi(jar);
  await store.get('/cart'); // genera cookie si no existe
  return { jar, store };
}

// Añade al carrito (producto simple o variación)
async function wooAddToCart(sessionId, id, quantity=1, variation=null) {
  const { store } = await wooEnsureCart(sessionId);
  const payload = { id, quantity };
  if (variation && Array.isArray(variation) && variation.length) {
    payload.variation = variation; // [{attribute:'pa_tamano', value:'250g'}]
  }
  const { data } = await store.post('/cart/add-item', payload);
  return data;
}

// Obtiene resumen del carrito
async function wooGetCart(sessionId) {
  const { store } = await wooEnsureCart(sessionId);
  const { data } = await store.get('/cart');
  return data;
}

// Carga variaciones de un producto variable
async function wooGetVariations(productId) {
  const res = await wooRest.get(`/products/${productId}/variations`, { params: { per_page: 100 }});
  return Array.isArray(res.data) ? res.data : [];
}

// Vacía el carrito real
async function wooEmptyCart(sessionId) {
  const { store } = await wooEnsureCart(sessionId);
  const cart = (await store.get('/cart')).data;
  const items = cart.items || [];
  for (const it of items) {
    try {
      await store.delete(`/cart/items/${encodeURIComponent(it.key)}`);
    } catch (e) {
      console.error('Woo remove item error', it.key, e?.response?.data || e.message);
    }
  }
}

// Render resumen de carrito Woo
function renderWooCart(cart) {
  const lines = (cart.items || []).map(it => {
    const name = it.name || 'Producto';
    const q = it.quantity || 0;
    const price = (it.prices?.price || 0) / 100;
    return `• ${q} × ${name} — ${price.toFixed(2)}€ c/u`;
  });
  const total = ((cart.totals?.total_price) || 0) / 100;
  return { text: (lines.length ? lines.join('\n') : '(vacío)'), total: total.toFixed(2) };
}

// ------------------------- Endpoint del Chat -------------------------
app.post('/api/chat', async (req, res) => {
  try {
    const { messages = [], language = 'auto', sessionId = 'anon' } = req.body;

    const lastUser = messages.at(-1) || { content: '' };
    const textoUser = String(lastUser.content || '').trim();
    if (!textoUser) return res.json({ reply: '(Sin respuesta)' });

    const selectedLanguage =
     language === 'inglés' ? 'inglés' : 'español';

    // Intents y patrones
    const reAdd = /(quiero|anadir|añade|pon|agrega|sumar)\s+(\d+)\s+(.+)/i;
    const reVer = /^(ver carrito|carrito)$/i;
    const reVac = /^(vaciar carrito|vaciar|limpiar carrito)$/i;
    const reConf = /^(confirmar pedido|confirmar|finalizar pedido)$/i;
    const reProductoQ =
      /(teneis|tieneis|tenéis|hay|venden|vendeis|vendéis|informacion|información|hablar|puedes hablar|me puedes hablar).*(mermelada|licor|vinagre|membrillo)s?\s+(de\s+)?/i;

    // Detección de producto/sabor (analítica)
    const cand = findCandidate(textoUser);
  
    const flavorTs = flavorTokensFrom(textoUser);
    const missing = flavorTs.filter(t => !catalogFlavorSet.has(t));

    let intent = 'other';
    if (reAdd.test(textoUser)) intent = 'add_to_cart';
    else if (reProductoQ.test(textoUser) || cand || flavorTs.length) intent = 'product_query';
    else if (reVer.test(textoUser)) intent = 'show_cart';
    else if (reVac.test(textoUser)) intent = 'clear_cart';
    else if (reConf.test(textoUser)) intent = 'confirm_order';

    // Registrar
    appendMessage({
      ts: new Date().toISOString(),
      sessionId,
      text: textoUser,
      language: selectedLanguage,
      intent,
      matchedProduct: cand ? cand.Producto : null,
      missingTokens: missing,
    });
    
    // ---------- Variación pendiente: resolver selección del usuario ----------
    if (pendingVariation[sessionId]) {
      const pend = pendingVariation[sessionId];
      const msg = textoUser.trim();

      // 1) ¿ha escrito un número?
      const num = parseInt(msg, 10);
      let chosen = null;
      if (!isNaN(num) && num >= 1 && num <= pend.options.length) {
        chosen = pend.options[num - 1];
      } else {
        // 2) Buscar por texto dentro del label normalizado
        const nmsg = normaliza(msg);
        chosen = pend.options.find(o => normaliza(o.label).includes(nmsg)) || null;
      }

      if (!chosen) {
        const lista = pend.options.slice(0,10).map((o,i)=>`• ${i+1}. ${o.label}`).join('\n');
        return res.json({ reply:
`No he reconocido esa opción. Elige una de la lista:
${lista}
(Responde con el número o el texto exacto)` });
      }

      // Añadir variación elegida al carrito real
      try {
        const variationAttrs = [];
        if (chosen.attrKey && chosen.value) {
          variationAttrs.push({ attribute: chosen.attrKey, value: chosen.value });
        }
        await wooAddToCart(sessionId, chosen.variation_id, pend.qty, variationAttrs);

        delete pendingVariation[sessionId];

        const cart = await wooGetCart(sessionId);
        const summary = renderWooCart(cart);
        return res.json({ reply:
`Añadido ✅
${summary.text}
Total (sin envío): ${summary.total}€

Sugerencias: Finalizar pedido | Ver carrito` });
      } catch (e) {
        console.error('Woo add variation error', e?.response?.data || e.message);
        return res.json({ reply: 'No he podido añadir esa variación ahora mismo. ¿Probamos otra opción?' });
      }
    }

    // ---------- Intenciones carrito Woo ----------
    if (reVer.test(textoUser)) {
      const cart = await wooGetCart(sessionId);
      const summary = renderWooCart(cart);
      return res.json({ reply: `Carrito (tienda):\n${summary.text}\nTotal (sin envío): ${summary.total}€` });
    }

    if (reVac.test(textoUser)) {
      await wooEmptyCart(sessionId);
      return res.json({ reply: 'He vaciado el carrito de la tienda.' });
    }

    if (reConf.test(textoUser)) {
      // Sin Stripe aquí: cuando el widget esté dentro de WordPress (Opción A)
      // abriremos /checkout con el carrito del navegador del cliente.
      const cart = await wooGetCart(sessionId);
      const summary = renderWooCart(cart);
      return res.json({ reply:
`Resumen antes de pagar:
${summary.text}
Total (sin envío): ${summary.total}€

Para finalizar, abre el checkout de la tienda desde la web. (Cuando incrustemos el chat en WordPress, te llevaré directo a /checkout).` });
    }

    // ---------- Añadir al carrito: usa Woo + variaciones ----------
    const m = textoUser.match(reAdd);
    if (m) {
      const cantidad = Math.max(1, parseInt(m[2], 10));
      const resto = m[3];

      // 1) Encuentra por NLP y/o texto
      let candi = findCandidate(resto);
      const searchName = candi?.Producto || resto;

      // 2) Busca en Woo por nombre
      const p = await wooFindProductByName(searchName);
      if (!p) {
        return res.json({ reply: 'Ahora mismo no encuentro ese producto en la tienda.' });
      }

      // 3) Producto variable → pedir variación
      const stockCheck = wooCheckStock(p, cantidad);
      if (!stockCheck.ok && stockCheck.reason === 'variable') {
        const vars = await wooGetVariations(p.id);
        if (!vars.length) {
          return res.json({ reply: `Ese producto requiere elegir una variación, pero no encuentro opciones. ¿Puedes decirme tamaño/sabor?` });
        }
        // Construir opciones legibles
        const opts = [];
        for (const v of vars) {
          const attr = (v.attributes||[]).map(a => ({ key: a.name, val: a.option }));
          const label = attr.map(a => `${a.key}: ${a.val}`).join(' · ');
          opts.push({
            label: label || (v.name || `Var ${v.id}`),
            attrKey: (v.attributes?.[0]?.name) || null, // ej. 'pa_tamano'
            value: (v.attributes?.[0]?.option) || null, // ej. '250g'
            variation_id: v.id
          });
        }
        pendingVariation[sessionId] = { productId: p.id, productName: p.name, options: opts, qty: cantidad };

        const lista = opts.slice(0,10).map((o,i)=>`• ${i+1}. ${o.label}`).join('\n');
        return res.json({ reply:
`Ese producto tiene variaciones. Elige una opción:
${lista}

Responde con el número (1-${Math.min(10,opts.length)}) o escribe el valor exacto (por ejemplo "250g").` });
      }

      // 4) Stock simple
      if (!stockCheck.ok) {
        if (stockCheck.reason === 'out') {
          return res.json({ reply: `Ahora mismo **${p.name}** está **agotado**.` });
        }
        if (stockCheck.reason === 'low') {
          return res.json({ reply: `Solo quedan **${stockCheck.available}** unidades de **${p.name}**. ¿Cuántas quieres?` });
        }
      }

      // 5) Añadir simple
      try {
        await wooAddToCart(sessionId, p.id, cantidad);
        const cart = await wooGetCart(sessionId);
        const summary = renderWooCart(cart);
        return res.json({ reply:
`Añadido ✅
${summary.text}
Total (sin envío): ${summary.total}€

Sugerencias: Finalizar pedido | Ver carrito` });
      } catch (e) {
        console.error('Woo add error', e?.response?.data || e.message);
        return res.json({ reply: 'No he podido añadirlo al carrito ahora mismo. Intenta de nuevo en unos segundos.' });
      }
    }

    // ---------- IA para preguntas normales (respuesta formateada) ----------
    const system = {
      role: 'system',
      content: `Eres el asistente de atención al cliente de "Sabores del Guijo Casa Alonso".
Estilo: cercano y artesanal, pero muy claro y escaneable.
Formatea SIEMPRE así:
- Empieza con una frase breve (máx. 2 líneas) que responda directo.
- Luego 3–6 viñetas "•" con detalles relevantes (sabores, formatos, sugerencias, envío).
- Si procede, añade una sección "Recomendación:" con 1–3 productos concretos (nombre exacto del catálogo).
- Termina con una línea "Sugerencias:" con 2–4 acciones cortas separadas por " | " (ej.: "Ver envío | Añadir 2 higo | Ver carrito").

Ejemplo de estructura:
Respuesta breve...
• Detalle 1
• Detalle 2
• Detalle 3
Recomendación: Mermelada de Higo 
Sugerencias: Ver carrito | Añadir 1 Higo | Envíos a Madrid

Regla crítica de idioma:
- Debes responder EXCLUSIVAMENTE en ${selectedLanguage}.
- No mezcles idiomas.
- Si ${selectedLanguage} es "inglés", traduce también los nombres de producto, categorías y descripciones al inglés natural.
- Si necesitas dar el nombre original del catálogo, puedes ponerlo entre paréntesis después de la traducción.
- Si ${selectedLanguage} es "español", responde todo en español.

Ejemplo si el idioma es inglés:
Recommendation: Extra Fig Jam (Mermelada Extra de Higo)

Catálogo (para nombrar bien):
${productosTexto}

Manual interno (contexto):
${manualEmpresa}

No inventes tamaños, formatos, porcentajes, ingredientes ni premios.
Solo menciona gramos, ml o formatos si aparecen literalmente en el catálogo o en el manual interno.
Responde solo sobre la empresa (productos, envíos, historia, pueblo).
Idioma: detecta el del usuario. Si no sabes algo, pide más contexto cordialmente.`
    };

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      messages: [system, ...messages],
    });

    const reply = completion.choices?.[0]?.message?.content ?? '(Sin respuesta)';
    res.json({ reply });
  } catch (err) {
    console.error('AI_ERROR:', err);
    res.status(500).json({ error: 'AI_ERROR', message: err.message });
  }
});

// ------------------------- APIs del panel (protegidas) -------------------------

// Lista de preguntas (con filtros)
app.get('/api/questions', requireAuth, (req, res) => {
  const all = loadMessages();
  const { from, to } = req.query;
  const filtered = (from || to) ? all.filter(m => inRange(m.ts, from, to)) : all;
  res.json({ count: filtered.length, items: filtered.slice(-1000) });
});

// Analítica (categoria-aware + plan B por sabor)
app.get('/api/analytics', requireAuth, (req, res) => {
  try {
    const all = loadMessages();
    const { from, to } = req.query;
    const data = (from || to) ? all.filter(m => inRange(m.ts, from, to)) : all;

    const reProductoQ =
      /(teneis|tieneis|tenéis|hay|venden|vendeis|vendéis|informacion|información|hablar|puedes hablar|me puedes hablar).*(mermelada|licor|vinagre|membrillo)s?\s+(de\s+)?/i;

    const counts = {};
    const miss = {};
    const byDay = {};

    for (const m of data) {
      const text = String(m.text || '');
      if (!text) continue;

      const day = (m.ts || '').slice(0, 10);
      if (day) byDay[day] = (byDay[day] || 0) + 1;

      const cand = findCandidate(text);
      const flavorTs = flavorTokensFrom(text);
      const presentFlavors = flavorTs.filter(t => catalogFlavorSet.has(t));
      const missing = flavorTs.filter(t => !catalogFlavorSet.has(t));

      const looksLikeProductQuery = reProductoQ.test(text) || Boolean(cand) || presentFlavors.length > 0;

      if (looksLikeProductQuery) {
        if (cand) {
          const name = cand.Producto;
          counts[name] = (counts[name] || 0) + 1;
        } else {
          const catFromUser = detectCategory(text); // puede ser null
          for (const fl of presentFlavors) {
            let display = null;
            if (catFromUser) {
              const key = `${catFromUser}|${fl}`;
              display = DISPLAY_BY_FLAVOR_AND_CAT.get(key) || pickDisplayByPriority(fl);
            } else {
              display = pickDisplayByPriority(fl);
            }
            if (display) counts[display] = (counts[display] || 0) + 1;
          }
        }
        for (const t of missing) miss[t] = (miss[t] || 0) + 1;
      }
    }

    const topProducts = Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    const missingInterests = Object.entries(miss)
      .map(([token, count]) => ({ token, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    const volumePerDay = Object.entries(byDay)
      .map(([day, count]) => ({ day, count }))
      .filter(r => r.day)
      .sort((a, b) => b.day.localeCompare(a.day));

    res.json({ topProducts, missingInterests, volumePerDay, totalQuestions: data.length, from: from||null, to: to||null });
  } catch (e) {
    console.error('ANALYTICS_ERROR:', e);
    res.status(500).json({ error: 'ANALYTICS_ERROR', message: e.message });
  }
});

// Export CSV (resumen con categoría en plan B)
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvRow(arr){ return arr.map(csvEscape).join(',') + '\n'; }

app.get('/api/export', requireAuth, (req, res) => {
  const all = loadMessages();
  const { from, to } = req.query;
  const data = (from || to) ? all.filter(m => inRange(m.ts, from, to)) : all;

  const reProductoQ =
    /(teneis|tieneis|tenéis|hay|venden|vendeis|vendéis|informacion|información|hablar|puedes hablar|me puedes hablar).*(mermelada|licor|vinagre|membrillo)s?\s+(de\s+)?/i;

  const counts = {};
  const miss = {};
  const byDay = {};

  for (const m of data) {
    const text = String(m.text || '');
    if (!text) continue;

    const day = (m.ts || '').slice(0, 10);
    if (day) byDay[day] = (byDay[day] || 0) + 1;

    const cand = findCandidate(text);
    const flavorTs = flavorTokensFrom(text);
    const presentFlavors = flavorTs.filter(t => catalogFlavorSet.has(t));
    const missing = flavorTs.filter(t => !catalogFlavorSet.has(t));

    const looksLikeProductQuery = reProductoQ.test(text) || Boolean(cand) || presentFlavors.length > 0;

    if (looksLikeProductQuery) {
      if (cand) {
        const name = cand.Producto;
        counts[name] = (counts[name] || 0) + 1;
      } else {
        const catFromUser = detectCategory(text); // puede ser null
        for (const fl of presentFlavors) {
          let display = null;
          if (catFromUser) {
            const key = `${catFromUser}|${fl}`;
            display = DISPLAY_BY_FLAVOR_AND_CAT.get(key) || pickDisplayByPriority(fl);
          } else {
            display = pickDisplayByPriority(fl);
          }
          if (display) counts[display] = (counts[display] || 0) + 1;
        }
      }
      for (const t of missing) miss[t] = (miss[t] || 0) + 1;
    }
  }

  const topProducts = Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a,b)=>b.count-a.count);
  const missingInterests = Object.entries(miss).map(([token, count]) => ({ token, count })).sort((a,b)=>b.count-a.count);
  const volumePerDay = Object.entries(byDay)
    .map(([day, count]) => ({ day, count }))
    .filter(r => r.day)
    .sort((a, b) => b.day.localeCompare(a.day));

  let csv = '\uFEFF';
  const rango = `Rango: ${from || 'todo'} — ${to || 'todo'}`;
  csv += csvRow(['Resumen analítico Sabores del Guijo']);
  csv += csvRow([rango]);
  csv += '\n';

  csv += csvRow(['Top productos (por nº de preguntas)']);
  csv += csvRow(['Producto','Preguntas']);
  if (topProducts.length) topProducts.forEach(r => csv += csvRow([r.name, r.count]));
  else csv += csvRow(['(sin datos en el rango)','0']);
  csv += '\n';

  csv += csvRow(['Interés en sabores NO disponibles']);
  csv += csvRow(['Sabor','Veces']);
  if (missingInterests.length) missingInterests.forEach(r => csv += csvRow([r.token, r.count]));
  else csv += csvRow(['(sin datos en el rango)','0']);
  csv += '\n';

  csv += csvRow(['Volumen de preguntas por día']);
  csv += csvRow(['Fecha','Preguntas']);
  if (volumePerDay.length) volumePerDay.forEach(r => csv += csvRow([r.day, r.count]));
  else csv += csvRow(['(sin datos en el rango)','0']);

  const fname = `sg-analitica-${from || 'all'}-${to || 'all'}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(csv);
});

// (Opcional) Diagnóstico de mapeo
app.get('/api/diagnose', requireAuth, (req, res) => {
  const q = String(req.query.q || '');
  const cand = findCandidate(q);
  const cat  = detectCategory(q);
  const flavors = flavorTokensFrom(q);
  const present = flavors.filter(t => catalogFlavorSet.has(t));
  const picks = present.map(fl => ({
    flavor: fl,
    byCat: cat ? DISPLAY_BY_FLAVOR_AND_CAT.get(`${cat}|${fl}`) || null : null,
    byPrio: pickDisplayByPriority(fl)
  }));
  res.json({
    q, cat, cand: cand ? cand.Producto : null, flavors, present, picks
  });
});

// ------------------------- Arranque -------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor listo en http://localhost:${PORT}`);
  console.log(`🗂️  Panel: http://localhost:${PORT}/admin`);
  console.log(`💬 Chat:  http://localhost:${PORT}/`);
});