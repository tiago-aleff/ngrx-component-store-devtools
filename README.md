# ngrx-component-store-devtools

Chrome extension that automatically connects **Angular NgRx ComponentStores** to the **Redux DevTools Extension** — no code changes required in your stores.

## How It Works

The extension injects a script into the page that:

1. **Intercepts** webpack module loading to find the `ComponentStore` base class
2. **Patches** the `initState`, `setState`, `patchState`, and `updater` methods
3. **Automatically connects** each store instance to Redux DevTools
4. **Sends state updates** with action names on every state change

Each store appears as a separate instance in Redux DevTools with the prefix `[ComponentStore]`.

## Requirements

- Google Chrome (or Chromium-based browser)
- [Redux DevTools Extension](https://chrome.google.com/webstore/detail/redux-devtools/lmhkpmbekcpmknklioeibfkpmmfibljd) installed
- Angular application using `@ngrx/component-store`

## Installation (Developer Mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/your-username/ngrx-component-store-devtools.git
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable **Developer mode** (toggle in the top-right corner)

4. Click **"Load unpacked"**

5. Select the root folder of this project

6. Done! The extension icon should appear in your toolbar

## Usage

1. Navigate to your Angular application
2. Open **Chrome DevTools** (F12)
3. Go to the **Redux** tab
4. In the instance dropdown, look for **`[ComponentStore] YourStoreName`**

Each store shows:
- Class name (e.g., `TodosStore`, `AuthStore`)
- Action history (`setState`, `patchState`, updater name)
- Full state snapshot on every change

## Development

To modify the extension:

1. Edit the source files
2. Go to `chrome://extensions/`
3. Click the **reload** button (↻) on the extension
4. Reload the Angular application page

## Project Structure

```
ngrx-component-store-devtools/
├── manifest.json                    # Chrome extension config (Manifest V3)
├── background.js                    # Service worker (badge + message relay)
├── content-script.js                # Injects the patch script into the page
├── inject/
│   └── patch-component-store.js     # Core script (monkey-patch + DevTools connection)
├── popup/
│   ├── popup.html                   # Extension popup UI
│   └── popup.js                     # Popup logic
└── icons/
    ├── icon.png
```

## Compatibility

> **Note:** This extension was developed and tested on an **Nx monorepo** project using:
> - Angular 15
> - `@ngrx/component-store` (fesm2015)
> - Webpack 5 (via `@nrwl/angular:webpack-browser`)
> - TypeScript target: ES2022
>
> It will likely require adjustments for other project setups (e.g., standalone Angular CLI projects, esbuild-based builds, or different webpack configurations).

### Known detection strategies

The extension uses multiple strategies to find and patch `ComponentStore`:

| Strategy | When it works |
|----------|---------------|
| `Object.defineProperty` proxy (deferred getter) | Webpack harmony exports with lazy getters |
| `Object.create` interception | ES5-style prototype chain setup |
| Webpack factory interception | Captures `__webpack_require__` from module factories |
| `__webpack_require__.d` hook | Catches exports as they're defined |
| DOM scan (`__ngContext__`) | Finds already-instantiated stores in Angular components |
| Periodic polling | Fallback for lazy-loaded modules |

## Limitations

- **Minified builds:** In production builds with aggressive minification, class names may be lost. The extension falls back to generic names like `ComponentStore_1`.
- **Time-travel not supported:** Redux DevTools shows state history, but time-travel replay is not possible since ComponentStore doesn't support external state replay.
- **esbuild:** Angular 16+ projects using esbuild instead of webpack are not supported yet.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No stores appear in Redux DevTools | Check the browser console for `[NgRx CS DevTools]` logs to see which detection stage fails |
| Extension shows "Redux DevTools Not Found" | Install the Redux DevTools Extension |
| Generic names (ComponentStore_1) | Normal in minified production builds |
| Stores not updating | Check console for errors from the extension |

