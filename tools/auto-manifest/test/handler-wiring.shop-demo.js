/**
 * Demo: run the handler-wiring step against the REAL web-shop-integration store
 * (a zustand store accessed through a bridge — the dominant real-world pattern)
 * to show the document + registry it produces for TypeScript/ESM apps.
 *
 * It copies only `src/store.ts` into a temp dir (never touches the committed
 * example) and uses the shop's real manifest actions. Run:
 *   node test/handler-wiring.shop-demo.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { wireHandlers } = require('../src/wireHandlers');

const SHOP = path.resolve(__dirname, '../../../examples/web-shop-integration');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-shop-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      { name: 'web-shop', dependencies: { react: '^18', zustand: '^4', typescript: '^5' } },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.copyFileSync(path.join(SHOP, 'src', 'store.ts'), path.join(dir, 'src', 'store.ts'));
  return dir;
}

// The shop's real manifest actions (from src/agent/manifest.ts).
const manifest = {
  appId: 'web-shop-demo',
  appName: 'Fyodos Web Shop',
  version: '1.0.0',
  routes: [{ intent: 'back', label: 'Back', route: 'BACK', examples: ['back'] }],
  actions: [
    {
      intent: 'addToCart',
      label: 'Añadir al carrito',
      handler: 'addToCart',
      requireConfirmation: false,
      parameters: { productId: { type: 'string', required: true, description: 'Id del producto' } },
      examples: ['añade una pizza'],
    },
    {
      intent: 'clearCart',
      label: 'Vaciar carrito',
      handler: 'clearCart',
      requireConfirmation: true,
      voiceConfirmation: 'standard',
      confirmationMessageTemplate: '¿Seguro que quieres vaciar el carrito?',
      idempotencyCheck: 'cartEmpty',
      parameters: {},
      examples: ['vacía el carrito'],
    },
    {
      intent: 'checkout',
      label: 'Finalizar compra',
      handler: 'checkout',
      requireConfirmation: true,
      voiceConfirmation: 'strict',
      confirmationPhrase: 'confirmar compra',
      confirmationMessageTemplate: '¿Confirmas la compra de tu pedido?',
      parameters: {},
      examples: ['paga'],
    },
  ],
  policies: { requireConfirmationForDestructive: true, allowedWithoutAuth: [], contextRetentionTurns: 10 },
};

const evidence = {
  actions: {
    addToCart: { file: 'src/store.ts', symbol: 'addToCart (zustand store method)' },
    clearCart: { file: 'src/store.ts', symbol: 'clearCart (zustand store method)' },
    checkout: { file: 'src/store.ts', symbol: 'checkout (zustand store method)' },
  },
};

async function main() {
  const dir = setup();
  const result = await wireHandlers(dir, {
    manifest,
    evidence,
    appName: manifest.appName,
    framework: 'vite',
    assumeYes: true,
    colors: {},
  });
  console.log(`\nstatus=${result.status} auto=${result.autoCount} manual=${result.manualCount}\n`);
  console.log('────────── FYODOS_HANDLERS.md ──────────');
  console.log(fs.readFileSync(result.docPath, 'utf8'));
  if (result.registryFile) {
    console.log('────────── handlers.generated.ts ──────────');
    console.log(fs.readFileSync(result.registryFile, 'utf8'));
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
