/**
 * NgRx ComponentStore DevTools Patch
 *
 * This script is injected into the page context and monkey-patches the
 * NgRx ComponentStore prototype to automatically connect each store instance
 * to the Redux DevTools Extension.
 *
 * Requirements:
 * - Redux DevTools Extension must be installed
 * - The Angular app must use @ngrx/component-store
 *
 * How it works:
 * 1. Waits for the app to bootstrap (polls for ng context on DOM)
 * 2. Intercepts ComponentStore's setState, patchState, and updater methods
 * 3. Creates a DevTools connection per store instance
 * 4. Sends state updates to DevTools on every state change
 */
(function () {
  'use strict';

  const POLL_INTERVAL = 2000;
  const MAX_POLL_ATTEMPTS = 300; // 10 minutes max (lazy modules may load late)

  let storeCount = 0;
  let patchApplied = false;

  /**
   * Notify the content script about the current status.
   */
  function notifyStatus(status, count) {
    window.postMessage(
      {
        type: 'NGRX_CS_DEVTOOLS_STATUS',
        payload: { status, storeCount: count },
      },
      '*'
    );
  }

  /**
   * Check if Redux DevTools Extension is available.
   */
  function hasReduxDevTools() {
    return typeof window.__REDUX_DEVTOOLS_EXTENSION__ !== 'undefined';
  }

  /**
   * Generate a readable name for the store instance.
   * Tries to use the class name, falls back to a generic name.
   */
  function getStoreName(instance) {
    const constructorName = instance.constructor && instance.constructor.name;

    // Skip generic/minified names
    if (
      constructorName &&
      constructorName !== 'ComponentStore' &&
      constructorName !== '_ComponentStore' &&
      constructorName.length > 2
    ) {
      return constructorName;
    }

    storeCount++;
    return `ComponentStore_${storeCount}`;
  }

  /**
   * Connect a ComponentStore instance to Redux DevTools.
   */
  function connectToDevTools(instance) {
    if (instance.__ngrxCsDevtools__) return; // Already connected
    console.log('[NgRx CS DevTools] 🔌 Connecting store instance to DevTools...');

    const name = getStoreName(instance);

    const devtools = window.__REDUX_DEVTOOLS_EXTENSION__.connect({
      name: `[ComponentStore] ${name}`,
      features: {
        jump: false,
        skip: false,
        dispatch: false,
      },
    });

    instance.__ngrxCsDevtools__ = devtools;
    instance.__ngrxCsDevtoolsName__ = name;

    // Get initial state
    let currentState = null;

    // Subscribe to state$ to track all state changes
    if (instance.state$) {
      instance.state$.subscribe({
        next: (state) => {
          currentState = state;

          if (!instance.__ngrxCsDevtoolsInitialized__) {
            devtools.init(state);
            instance.__ngrxCsDevtoolsInitialized__ = true;
          } else {
            const actionName =
              instance.__ngrxCsLastAction__ || 'state_update';
            devtools.send({ type: actionName }, state);
            instance.__ngrxCsLastAction__ = null;
          }
        },
        error: () => {},
      });
    }

    notifyStatus('connected', storeCount);
    console.log(
      `%c[NgRx CS DevTools]%c Connected: ${name}`,
      'color: #7B1FA2; font-weight: bold',
      'color: inherit'
    );
  }

  /**
   * Patch the ComponentStore prototype methods to capture action names.
   * If given a subclass, walks up the prototype chain to find the base ComponentStore.
   */
  function patchComponentStorePrototype(ComponentStoreClass) {
    if (!ComponentStoreClass || !ComponentStoreClass.prototype) return;

    // Walk up the prototype chain to find the actual base ComponentStore class
    // (not a subclass like TodosStore or UsersStore)
    let baseClass = ComponentStoreClass;
    let proto = Object.getPrototypeOf(ComponentStoreClass.prototype);
    while (proto && proto !== Object.prototype) {
      if (isComponentStoreProto(proto)) {
        baseClass = proto.constructor;
      }
      proto = Object.getPrototypeOf(proto);
    }

    if (baseClass !== ComponentStoreClass) {
      console.log(`[NgRx CS DevTools] 📌 Found via subclass ${ComponentStoreClass.name}, patching base class: ${baseClass.name}`);
    }

    const baseProto = baseClass.prototype;

    // Patch initState - this is called during construction (super(initialState))
    const originalInitState = baseProto.initState;
    if (originalInitState && !baseProto.__ngrxCsPatched__) {
      baseProto.__ngrxCsPatched__ = true;

      baseProto.initState = function (state) {
        const result = originalInitState.call(this, state);

        // Connect to DevTools after initState
        if (!this.__ngrxCsDevtools__ && hasReduxDevTools()) {
          console.log('[NgRx CS DevTools] 🔗 New ComponentStore instance detected via initState:', this.constructor?.name || '(unknown)');
          setTimeout(() => connectToDevTools(this), 0);
        }

        return result;
      };

      // Patch setState
      const originalSetState = baseProto.setState;
      if (originalSetState) {
        baseProto.setState = function (stateOrUpdater) {
          this.__ngrxCsLastAction__ = 'setState';
          const result = originalSetState.call(this, stateOrUpdater);

          if (!this.__ngrxCsDevtools__ && hasReduxDevTools()) {
            console.log('[NgRx CS DevTools] 🔗 New ComponentStore instance detected via setState:', this.constructor?.name || '(unknown)');
            setTimeout(() => connectToDevTools(this), 0);
          }

          return result;
        };
      }

      // Patch patchState
      const originalPatchState = baseProto.patchState;
      if (originalPatchState) {
        baseProto.patchState = function (partialState) {
          this.__ngrxCsLastAction__ = 'patchState';
          return originalPatchState.call(this, partialState);
        };
      }

      // Patch updater to capture custom updater names
      const originalUpdater = baseProto.updater;
      if (originalUpdater) {
        baseProto.updater = function (updaterFn) {
          const updaterResult = originalUpdater.call(this, updaterFn);

          const store = this;
          const wrappedUpdater = function (...args) {
            const fnName = updaterFn.name || 'updater';
            store.__ngrxCsLastAction__ = fnName;
            return updaterResult.apply(this, args);
          };

          if (updaterResult.subscribe) {
            wrappedUpdater.subscribe = updaterResult.subscribe.bind(updaterResult);
          }

          return wrappedUpdater;
        };
      }
    }

    patchApplied = true;
    console.log(
      `%c[NgRx CS DevTools]%c Patch applied to ${baseClass.name} prototype`,
      'color: #7B1FA2; font-weight: bold',
      'color: inherit'
    );

    // After patching, find and connect existing instances that were created before the patch
    setTimeout(() => connectExistingInstances(baseClass), 500);
  }

  /**
   * Find and connect ComponentStore instances that were created before the patch was applied.
   * Scans the DOM for Angular components that have stores injected.
   */
  function connectExistingInstances(ComponentStoreClass) {
    console.log('[NgRx CS DevTools] 🔍 Searching for existing ComponentStore instances...');
    let connected = 0;
    const visited = new WeakSet();

    function tryConnect(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (visited.has(obj)) return;
      try { visited.add(obj); } catch(e) { return; }

      if (obj.__ngrxCsDevtools__) return; // already connected

      // Check if this is a ComponentStore instance
      const isInstance = (obj instanceof ComponentStoreClass) || isComponentStoreInstance(obj);
      if (isInstance) {
        console.log('[NgRx CS DevTools] 🔌 Connecting existing instance:', obj.constructor?.name);
        connectToDevTools(obj);
        connected++;
        return;
      }

      // Check own properties for injected stores
      try {
        const keys = Object.getOwnPropertyNames(obj);
        for (const key of keys) {
          if (key.startsWith('__') || key.startsWith('ɵ')) continue;
          try {
            const desc = Object.getOwnPropertyDescriptor(obj, key);
            if (!desc || !desc.value || typeof desc.value !== 'object') continue;
            const prop = desc.value;
            if (prop && !visited.has(prop) && ((prop instanceof ComponentStoreClass) || isComponentStoreInstance(prop))) {
              if (!prop.__ngrxCsDevtools__) {
                console.log(`[NgRx CS DevTools] 🔌 Connecting existing instance from ${obj.constructor?.name}.${key}:`, prop.constructor?.name);
                connectToDevTools(prop);
                connected++;
              }
            }
          } catch (e) { continue; }
        }
      } catch (e) {}
    }

    // Scan DOM elements for Angular LView contexts
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      const ngContext = el.__ngContext__;
      if (!ngContext || !Array.isArray(ngContext)) continue;

      for (let i = 0; i < ngContext.length; i++) {
        const item = ngContext[i];
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        tryConnect(item);
      }
    }

    console.log(`[NgRx CS DevTools] 📊 Retroactive scan: ${connected} existing instances connected`);

    // Keep scanning periodically for lazy-loaded stores
    let retryCount = 0;
    const retryInterval = setInterval(() => {
      retryCount++;
      if (retryCount > 120) { // 2 minutes
        clearInterval(retryInterval);
        return;
      }

      const elements = document.querySelectorAll('*');
      for (const el of elements) {
        const ctx = el.__ngContext__;
        if (!ctx || !Array.isArray(ctx)) continue;
        for (let i = 0; i < ctx.length; i++) {
          const item = ctx[i];
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          tryConnect(item);
        }
      }
    }, 1000);
  }

  /**
   * Try to find the ComponentStore class from the ngrx module loaded in the page.
   * Multiple strategies are used since module bundlers handle things differently.
   */
  function findAndPatchComponentStore() {
    console.log('[NgRx CS DevTools] 🔍 Polling: searching for ComponentStore instances...');

    // Strategy 1: Look for ComponentStore on global ngrx exports
    if (window.ngrx && window.ngrx.ComponentStore) {
      console.log('[NgRx CS DevTools] ✅ Found via window.ngrx global');
      patchComponentStorePrototype(window.ngrx.ComponentStore);
      return true;
    }

    // Strategy 2: Scan webpack module registry for ComponentStore class
    if (findInWebpackModules()) {
      return true;
    }

    return false;
  }

  /**
   * Scan webpack's internal module cache for the ComponentStore class.
   * Since __webpack_require__ is not on window, we extract it from the
   * webpackChunk's push mechanism.
   */
  let cachedWebpackRequire = null;

  function getWebpackRequire() {
    if (cachedWebpackRequire) return cachedWebpackRequire;

    // Strategy: webpack's chunk loading calls a function that receives __webpack_require__
    // We can extract it by inspecting the chunk array's original push (webpackJsonpCallback)
    // The push function's closure contains __webpack_require__

    // Alternative: search for it on the window under different names
    const candidates = [
      window.__webpack_require__,
      window.webpackJsonp,
    ];

    for (const candidate of candidates) {
      if (candidate && candidate.c) {
        cachedWebpackRequire = candidate;
        return candidate;
      }
    }

    // Try to extract from chunk array internals
    const chunkNames = Object.keys(window).filter(key => key.startsWith('webpackChunk'));
    for (const chunkName of chunkNames) {
      const chunkArray = window[chunkName];
      if (!chunkArray) continue;

      // In webpack 5, the chunk array has a custom push that is actually webpackJsonpCallback
      // We can try to get __webpack_require__ by looking at the function's scope
      // Unfortunately this isn't directly accessible, so we'll use a different approach
    }

    return null;
  }

  function findInWebpackModules() {
    const req = getWebpackRequire();
    if (!req) {
      console.log('[NgRx CS DevTools] ⚠️ __webpack_require__ not available, trying chunk inspection...');
      // Fallback: try to find ComponentStore by inspecting loaded scripts
      return findComponentStoreViaPrototypeChain();
    }

    if (!req.c) {
      console.log('[NgRx CS DevTools] ⚠️ __webpack_require__.c (module cache) not available');
      return false;
    }

    const moduleCache = req.c;
    const moduleCount = Object.keys(moduleCache).length;
    console.log(`[NgRx CS DevTools] 📋 Scanning webpack module cache: ${moduleCount} modules loaded`);

    for (const moduleId of Object.keys(moduleCache)) {
      const mod = moduleCache[moduleId];
      if (!mod || !mod.exports) continue;

      const exports = mod.exports;
      for (const exportKey of Object.keys(exports)) {
        try {
          const val = exports[exportKey];
          if (!val || typeof val !== 'function' || !val.prototype) continue;
          if (isComponentStoreProto(val.prototype)) {
            console.log('[NgRx CS DevTools] ✅ Found ComponentStore via webpack module cache!', {
              moduleId, exportKey, className: val.name,
            });
            patchComponentStorePrototype(val);
            return true;
          }
        } catch (e) {
          continue;
        }
      }
    }

    console.log('[NgRx CS DevTools] ❌ ComponentStore not found in webpack module cache');
    return false;
  }

  /**
   * Find ComponentStore by searching through all constructor prototypes
   * of Angular-managed objects found in the DOM.
   * This works even when webpack module cache isn't accessible.
   */
  function findComponentStoreViaPrototypeChain() {
    // Scan all elements looking for Angular context
    const everyElement = document.querySelectorAll('*');
    let elementsWithContext = 0;
    let objectsScanned = 0;
    let instancesFound = 0;

    for (const el of everyElement) {
      const ngContext = el.__ngContext__;
      if (!ngContext) continue;

      elementsWithContext++;

      // ngContext can be a number (LView index) or the LView array itself
      if (typeof ngContext === 'number') continue;
      if (!Array.isArray(ngContext)) continue;

      // Angular LView is a flat array. Component instances are at specific indices.
      // We scan all items looking for objects with ComponentStore shape.
      for (let i = 0; i < ngContext.length; i++) {
        const item = ngContext[i];
        if (!item || typeof item !== 'object') continue;
        if (Array.isArray(item)) continue; // skip nested LViews

        objectsScanned++;

        // Direct check: is this a ComponentStore instance?
        if (isComponentStoreInstance(item)) {
          instancesFound++;
          console.log(`[NgRx CS DevTools] 🎯 Found store instance at LView[${i}]:`, item.constructor?.name);
          const baseClass = findComponentStoreBaseClass(item);
          if (baseClass) {
            patchComponentStorePrototype(baseClass);
            connectToDevTools(item);
            return true;
          }
        }

        // Check all own properties (stores injected into components via DI)
        try {
          const keys = Object.getOwnPropertyNames(item);
          for (const key of keys) {
            if (key.startsWith('__')) continue; // skip internal props
            try {
              const descriptor = Object.getOwnPropertyDescriptor(item, key);
              if (!descriptor || !descriptor.value) continue;
              const prop = descriptor.value;
              if (prop && typeof prop === 'object' && prop !== item && isComponentStoreInstance(prop)) {
                instancesFound++;
                console.log(`[NgRx CS DevTools] 🎯 Found store in ${item.constructor?.name}.${key}:`, prop.constructor?.name);
                const baseClass = findComponentStoreBaseClass(prop);
                if (baseClass) {
                  patchComponentStorePrototype(baseClass);
                  connectToDevTools(prop);
                  return true;
                }
              }
            } catch (e) {
              continue;
            }
          }
        } catch (e) {
          continue;
        }
      }
    }

    console.log(`[NgRx CS DevTools] 📊 DOM scan: ${elementsWithContext} elements with ngContext, ${objectsScanned} objects scanned, ${instancesFound} potential stores found`);
    return false;
  }

  /**
   * Scan Angular components in the DOM for injected ComponentStore instances.
   * Traverses all elements with Angular context and checks their injector.
   */
  /**
   * Check if an object looks like a ComponentStore instance.
   */
  function isComponentStoreInstance(obj) {
    try {
      return (
        obj &&
        typeof obj === 'object' &&
        obj.state$ &&
        typeof obj.setState === 'function' &&
        typeof obj.select === 'function' &&
        typeof obj.updater === 'function'
      );
    } catch (e) {
      return false;
    }
  }

  /**
   * Walk up the prototype chain to find the ComponentStore base class.
   */
  function findComponentStoreBaseClass(instance) {
    let proto = Object.getPrototypeOf(instance);

    while (proto && proto !== Object.prototype) {
      if (isComponentStoreProto(proto)) {
        return proto.constructor;
      }
      proto = Object.getPrototypeOf(proto);
    }

    return null;
  }

  /**
   * Check if a given object looks like a ComponentStore prototype.
   */
  function isComponentStoreProto(proto) {
    try {
      return (
        proto &&
        typeof proto === 'object' &&
        typeof proto.setState === 'function' &&
        typeof proto.updater === 'function' &&
        typeof proto.select === 'function' &&
        typeof proto.effect === 'function'
      );
    } catch (e) {
      return false;
    }
  }

  /**
   * Alternative strategy: Intercept module loading via webpack/SystemJS hooks.
   * This patches ComponentStore as soon as its module is loaded.
   */
  function interceptModuleLoading() {
    console.log('[NgRx CS DevTools] 🔧 Setting up module interception (defineProperty + Object.create)');
    let intercepted = false;

    // Collect getters to check after module execution completes.
    // webpack's __webpack_require__.d defines getters BEFORE the class body executes,
    // so calling getter() immediately returns undefined. We defer checking.
    const pendingGetters = [];
    let checkScheduled = false;

    function scheduleDeferredCheck() {
      if (checkScheduled || intercepted || patchApplied) return;
      checkScheduled = true;

      // Use setTimeout(0) to run AFTER the current module factory completes
      setTimeout(() => {
        checkScheduled = false;
        if (intercepted || patchApplied) return;

        for (let i = pendingGetters.length - 1; i >= 0; i--) {
          try {
            const getter = pendingGetters[i];
            const val = getter();
            if (
              val &&
              typeof val === 'function' &&
              val.prototype &&
              isComponentStoreProto(val.prototype)
            ) {
              console.log('[NgRx CS DevTools] ✅ Found ComponentStore via deferred getter check!', val.name || '(anonymous)');
              patchComponentStorePrototype(val);
              intercepted = true;
              pendingGetters.length = 0;
              return;
            }
          } catch (e) {
            continue;
          }
        }
      }, 0);
    }

    // Strategy 1: Intercept Object.defineProperty
    const handler = {
      apply(target, thisArg, args) {
        const result = Reflect.apply(target, thisArg, args);

        if (intercepted || patchApplied) return result;

        try {
          const descriptor = args[2];
          if (!descriptor) return result;

          // Immediate check for value-based definitions
          if (descriptor.value && typeof descriptor.value === 'function') {
            const val = descriptor.value;
            if (val.prototype && isComponentStoreProto(val.prototype)) {
              console.log('[NgRx CS DevTools] ✅ Found ComponentStore via Object.defineProperty (value)!', val.name || '(anonymous)');
              patchComponentStorePrototype(val);
              intercepted = true;
              return result;
            }
          }

          // For getter-based definitions (webpack harmony exports), collect and defer
          if (typeof descriptor.get === 'function') {
            pendingGetters.push(descriptor.get);
            scheduleDeferredCheck();
          }
        } catch (e) {
          // Ignore
        }

        return result;
      },
    };

    try {
      Object.defineProperty = new Proxy(Object.defineProperty, handler);
    } catch (e) {
      // Fallback: rely on polling
    }

    // Strategy 2: Intercept Object.create
    const originalCreate = Object.create;
    Object.create = function (proto, properties) {
      const result = originalCreate.call(this, proto, properties);

      if (!intercepted && !patchApplied && isComponentStoreProto(proto)) {
        console.log('[NgRx CS DevTools] ✅ Found ComponentStore via Object.create!');
        const ctor = proto.constructor || Object.getPrototypeOf(proto)?.constructor;
        if (ctor) {
          patchComponentStorePrototype(ctor);
          intercepted = true;
        }
      }

      return result;
    };

    // Strategy 3: webpackChunk interception is handled by interceptViaWebpackInjection()
  }

  /**
   * Intercept webpackChunk array pushes to run a callback when new chunks load.
   * This ensures we detect ComponentStore even in lazy-loaded modules,
   * regardless of timing.
   */
  /**
   * Poll-based fallback: Periodically check for ComponentStore instances.
   */
  function startPolling() {
    console.log('[NgRx CS DevTools] 🔄 Starting polling fallback (every 500ms)');
    let attempts = 0;

    const intervalId = setInterval(() => {
      attempts++;

      if (patchApplied || attempts >= MAX_POLL_ATTEMPTS) {
        clearInterval(intervalId);

        if (!patchApplied) {
          notifyStatus('no_stores_found', 0);
          console.log(
            '%c[NgRx CS DevTools]%c No ComponentStore found on this page',
            'color: #7B1FA2; font-weight: bold',
            'color: #999'
          );
        }
        return;
      }

      if (!hasReduxDevTools()) {
        clearInterval(intervalId);
        notifyStatus('no_devtools', 0);
        console.log(
          '%c[NgRx CS DevTools]%c Redux DevTools Extension not detected',
          'color: #7B1FA2; font-weight: bold',
          'color: #F44336'
        );
        return;
      }

      findAndPatchComponentStore();
    }, POLL_INTERVAL);
  }

  /**
   * STRATEGY: Intercept webpack chunk loading to capture __webpack_require__.
   * 
   * webpack chunks have the format: push([chunkIds, modules, runtime])
   * - Each module factory receives (__unused_webpack_module, __webpack_exports__, __webpack_require__)
   * - We wrap module factories to capture __webpack_require__ when they execute
   * - Then scan the module cache for ComponentStore
   * 
   * Also: intercept __webpack_require__.d which is used to define harmony exports.
   * This is called for every `export` in every module, giving us access to all exported values.
   */
  function interceptViaWebpackInjection() {
    console.log('[NgRx CS DevTools] 💉 Setting up webpack factory interception...');

    const chunkNames = Object.keys(window).filter(key => key.startsWith('webpackChunk'));

    for (const chunkName of chunkNames) {
      const chunkArray = window[chunkName];
      if (!Array.isArray(chunkArray)) continue;

      // Wrap the push to intercept future chunks
      const originalPush = chunkArray.push.bind(chunkArray);
      chunkArray.push = function (chunk) {
        if (patchApplied) return originalPush(chunk);

        // chunk = [chunkIds, modules, runtime?]
        const modules = chunk[1];
        if (modules && typeof modules === 'object') {
          // Wrap each module factory to capture __webpack_require__
          for (const moduleId of Object.keys(modules)) {
            const originalFactory = modules[moduleId];
            if (typeof originalFactory !== 'function') continue;

            modules[moduleId] = function (module, exports, __webpack_require__) {
              // Execute original factory
              originalFactory.call(this, module, exports, __webpack_require__);

              // Now we have __webpack_require__! Cache it and try to scan
              if (!patchApplied && !cachedWebpackRequire && __webpack_require__) {
                cachedWebpackRequire = __webpack_require__;
                console.log('[NgRx CS DevTools] 💉 Captured __webpack_require__ from module factory!');
                
                // Intercept __webpack_require__.d to catch exports as they're defined
                interceptWebpackDefineExport(__webpack_require__);
                
                // Try immediate scan
                if (__webpack_require__.c) {
                  scanModuleCache(__webpack_require__.c);
                }
              }

              // Also check this specific module's exports after it runs
              if (!patchApplied && exports) {
                checkExportsForComponentStore(exports, moduleId);
              }
            };
          }
        }

        return originalPush(chunk);
      };

      // Also process chunks that already loaded (they're in the array)
      for (const existingChunk of chunkArray) {
        if (!existingChunk || !existingChunk[1]) continue;
        // These already executed, we can't wrap them.
        // But if there's a runtime (3rd element), try to extract __webpack_require__
        if (existingChunk[2] && typeof existingChunk[2] === 'function') {
          try {
            // The runtime function receives __webpack_require__
            // but calling it again might cause issues, skip this
          } catch (e) {}
        }
      }

      console.log(`[NgRx CS DevTools] 👀 Intercepting module factories on "${chunkName}" (${chunkArray.length} chunks already loaded)`);
    }
  }

  /**
   * Intercept __webpack_require__.d which defines harmony exports.
   * This is called as: __webpack_require__.d(exports, { ExportName: () => localVar })
   * We can check each exported value as it's defined.
   */
  function interceptWebpackDefineExport(__webpack_require__) {
    if (!__webpack_require__.d) return;

    const originalD = __webpack_require__.d;
    __webpack_require__.d = function (exports, definition) {
      // Call original first
      originalD.call(this, exports, definition);

      if (patchApplied) return;

      // Check each defined export
      for (const key of Object.keys(definition)) {
        try {
          const getter = definition[key];
          if (typeof getter !== 'function') continue;
          const val = getter();
          
          if (
            val &&
            typeof val === 'function' &&
            val.prototype &&
            isComponentStoreProto(val.prototype)
          ) {
            console.log('[NgRx CS DevTools] ✅ Found ComponentStore via __webpack_require__.d!', val.name || key);
            patchComponentStorePrototype(val);
          }
        } catch (e) {
          continue;
        }
      }
    };
  }

  /**
   * Check a module's exports object for ComponentStore.
   */
  function checkExportsForComponentStore(exports, moduleId) {
    try {
      const keys = Object.keys(exports);
      for (const key of keys) {
        const val = exports[key];
        if (
          val &&
          typeof val === 'function' &&
          val.prototype &&
          isComponentStoreProto(val.prototype)
        ) {
          console.log(`[NgRx CS DevTools] ✅ Found ComponentStore in module ${moduleId}, export "${key}":`, val.name);
          patchComponentStorePrototype(val);
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  /**
   * Scan webpack module cache for ComponentStore class.
   */
  function scanModuleCache(cache) {
    if (patchApplied) return;

    const moduleCount = Object.keys(cache).length;
    console.log(`[NgRx CS DevTools] 📋 Scanning module cache: ${moduleCount} modules`);

    for (const moduleId of Object.keys(cache)) {
      const mod = cache[moduleId];
      if (!mod || !mod.exports) continue;
      if (checkExportsForComponentStore(mod.exports, moduleId)) return;
    }
  }

  /**
   * Main entry point.
   */
  function init() {
    console.log('[NgRx CS DevTools] 🚀 Initializing...');

    if (!hasReduxDevTools()) {
      console.log(
        '%c[NgRx CS DevTools]%c Waiting for Redux DevTools Extension...',
        'color: #7B1FA2; font-weight: bold',
        'color: #FF9800'
      );
      notifyStatus('no_devtools', 0);
      return;
    }

    notifyStatus('scanning', 0);

    // Start module interception immediately (defineProperty, Object.create, webpackChunk)
    interceptModuleLoading();

    // Intercept class instantiation (catches DI-created stores)
    interceptViaWebpackInjection();

    // Try an immediate scan of webpack module cache
    // (the vendor chunk with @ngrx/component-store may already be loaded)
    console.log('[NgRx CS DevTools] 🔎 Attempting immediate webpack module cache scan...');
    if (findInWebpackModules()) {
      console.log('[NgRx CS DevTools] ✅ Found ComponentStore in initial webpack cache scan!');
      return; // Patch applied, no need for polling
    }

    // Also start polling as a fallback
    startPolling();
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
