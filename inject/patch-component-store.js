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
 * 1. Intercepts webpack module loading to find the ComponentStore base class
 * 2. Patches initState, setState, patchState, and updater methods
 * 3. Creates a DevTools connection per store instance
 * 4. Sends state updates to DevTools on every state change
 */
(function () {
  'use strict';

  const POLL_INTERVAL = 2000;
  const MAX_POLL_ATTEMPTS = 300;

  let storeCount = 0;
  let patchApplied = false;
  let cachedWebpackRequire = null;

  function notifyStatus(status, count) {
    window.postMessage(
      { type: 'NGRX_CS_DEVTOOLS_STATUS', payload: { status, storeCount: count } },
      '*'
    );
  }

  function hasReduxDevTools() {
    return typeof window.__REDUX_DEVTOOLS_EXTENSION__ !== 'undefined';
  }

  function getStoreName(instance) {
    const constructorName = instance.constructor && instance.constructor.name;

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
    if (instance.__ngrxCsDevtools__) return;

    const name = getStoreName(instance);

    const devtools = window.__REDUX_DEVTOOLS_EXTENSION__.connect({
      name: `[ComponentStore] ${name}`,
      features: { jump: false, skip: false, dispatch: false },
    });

    instance.__ngrxCsDevtools__ = devtools;
    instance.__ngrxCsDevtoolsName__ = name;

    if (instance.state$) {
      instance.state$.subscribe({
        next: (state) => {
          if (!instance.__ngrxCsDevtoolsInitialized__) {
            devtools.init(state);
            instance.__ngrxCsDevtoolsInitialized__ = true;
          } else {
            const actionName = instance.__ngrxCsLastAction__ || 'state_update';
            devtools.send({ type: actionName }, state);
            instance.__ngrxCsLastAction__ = null;
          }
        },
        error: () => {},
      });
    }

    storeCount++;
    notifyStatus('connected', storeCount);
    console.log(
      `%c[NgRx CS DevTools]%c Connected: ${name}`,
      'color: #7B1FA2; font-weight: bold',
      'color: inherit'
    );
  }

  /**
   * Patch the ComponentStore prototype methods.
   * Walks up the prototype chain to find the base ComponentStore class.
   */
  function patchComponentStorePrototype(ComponentStoreClass) {
    if (!ComponentStoreClass || !ComponentStoreClass.prototype) return;

    // Find the base ComponentStore class (not a subclass)
    let baseClass = ComponentStoreClass;
    let proto = Object.getPrototypeOf(ComponentStoreClass.prototype);
    while (proto && proto !== Object.prototype) {
      if (isComponentStoreProto(proto)) {
        baseClass = proto.constructor;
      }
      proto = Object.getPrototypeOf(proto);
    }

    const baseProto = baseClass.prototype;
    if (baseProto.__ngrxCsPatched__) return;
    baseProto.__ngrxCsPatched__ = true;

    // Patch initState (called during construction via super(initialState))
    const originalInitState = baseProto.initState;
    if (originalInitState) {
      baseProto.initState = function (state) {
        const result = originalInitState.call(this, state);
        if (!this.__ngrxCsDevtools__ && hasReduxDevTools()) {
          setTimeout(() => connectToDevTools(this), 0);
        }
        return result;
      };
    }

    // Patch setState
    const originalSetState = baseProto.setState;
    if (originalSetState) {
      baseProto.setState = function (stateOrUpdater) {
        this.__ngrxCsLastAction__ = 'setState';
        const result = originalSetState.call(this, stateOrUpdater);
        if (!this.__ngrxCsDevtools__ && hasReduxDevTools()) {
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

    // Patch updater
    const originalUpdater = baseProto.updater;
    if (originalUpdater) {
      baseProto.updater = function (updaterFn) {
        const updaterResult = originalUpdater.call(this, updaterFn);
        const store = this;
        const wrappedUpdater = function (...args) {
          store.__ngrxCsLastAction__ = updaterFn.name || 'updater';
          return updaterResult.apply(this, args);
        };
        if (updaterResult.subscribe) {
          wrappedUpdater.subscribe = updaterResult.subscribe.bind(updaterResult);
        }
        return wrappedUpdater;
      };
    }

    patchApplied = true;
    console.log(
      '%c[NgRx CS DevTools]%c Patch applied',
      'color: #7B1FA2; font-weight: bold',
      'color: inherit'
    );

    // Connect existing instances created before the patch
    setTimeout(() => connectExistingInstances(baseClass), 500);
  }

  /**
   * Find and connect ComponentStore instances created before the patch.
   */
  function connectExistingInstances(ComponentStoreClass) {
    const visited = new WeakSet();

    function tryConnect(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (visited.has(obj)) return;
      try { visited.add(obj); } catch (e) { return; }
      if (obj.__ngrxCsDevtools__) return;

      const isInstance = (obj instanceof ComponentStoreClass) || isComponentStoreInstance(obj);
      if (isInstance) {
        connectToDevTools(obj);
        return;
      }

      // Check properties for injected stores
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
                connectToDevTools(prop);
              }
            }
          } catch (e) { continue; }
        }
      } catch (e) {}
    }

    function scanDOM() {
      const elements = document.querySelectorAll('*');
      for (const el of elements) {
        const ngContext = el.__ngContext__;
        if (!ngContext || !Array.isArray(ngContext)) continue;
        for (let i = 0; i < ngContext.length; i++) {
          const item = ngContext[i];
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          tryConnect(item);
        }
      }
    }

    scanDOM();

    // Keep scanning for lazy-loaded stores
    let retryCount = 0;
    const retryInterval = setInterval(() => {
      retryCount++;
      if (retryCount > 120) {
        clearInterval(retryInterval);
        return;
      }
      scanDOM();
    }, 1000);
  }

  // --- Detection strategies ---

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

  function findComponentStoreBaseClass(instance) {
    let proto = Object.getPrototypeOf(instance);
    while (proto && proto !== Object.prototype) {
      if (isComponentStoreProto(proto)) return proto.constructor;
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }

  function findAndPatchComponentStore() {
    if (window.ngrx && window.ngrx.ComponentStore) {
      patchComponentStorePrototype(window.ngrx.ComponentStore);
      return true;
    }
    if (findInWebpackModules()) return true;
    return false;
  }

  function getWebpackRequire() {
    if (cachedWebpackRequire) return cachedWebpackRequire;
    const candidates = [window.__webpack_require__, window.webpackJsonp];
    for (const candidate of candidates) {
      if (candidate && candidate.c) {
        cachedWebpackRequire = candidate;
        return candidate;
      }
    }
    return null;
  }

  function findInWebpackModules() {
    const req = getWebpackRequire();
    if (!req || !req.c) {
      return findComponentStoreViaPrototypeChain();
    }

    const moduleCache = req.c;
    for (const moduleId of Object.keys(moduleCache)) {
      const mod = moduleCache[moduleId];
      if (!mod || !mod.exports) continue;
      for (const exportKey of Object.keys(mod.exports)) {
        try {
          const val = mod.exports[exportKey];
          if (val && typeof val === 'function' && val.prototype && isComponentStoreProto(val.prototype)) {
            patchComponentStorePrototype(val);
            return true;
          }
        } catch (e) { continue; }
      }
    }
    return false;
  }

  function findComponentStoreViaPrototypeChain() {
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      const ngContext = el.__ngContext__;
      if (!ngContext || typeof ngContext === 'number' || !Array.isArray(ngContext)) continue;

      for (let i = 0; i < ngContext.length; i++) {
        const item = ngContext[i];
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

        if (isComponentStoreInstance(item)) {
          const baseClass = findComponentStoreBaseClass(item);
          if (baseClass) {
            patchComponentStorePrototype(baseClass);
            connectToDevTools(item);
            return true;
          }
        }

        try {
          const keys = Object.getOwnPropertyNames(item);
          for (const key of keys) {
            if (key.startsWith('__')) continue;
            try {
              const desc = Object.getOwnPropertyDescriptor(item, key);
              if (!desc || !desc.value) continue;
              const prop = desc.value;
              if (prop && typeof prop === 'object' && prop !== item && isComponentStoreInstance(prop)) {
                const baseClass = findComponentStoreBaseClass(prop);
                if (baseClass) {
                  patchComponentStorePrototype(baseClass);
                  connectToDevTools(prop);
                  return true;
                }
              }
            } catch (e) { continue; }
          }
        } catch (e) { continue; }
      }
    }
    return false;
  }

  // --- Module interception ---

  function interceptModuleLoading() {
    let intercepted = false;
    const pendingGetters = [];
    let checkScheduled = false;

    function scheduleDeferredCheck() {
      if (checkScheduled || intercepted || patchApplied) return;
      checkScheduled = true;
      setTimeout(() => {
        checkScheduled = false;
        if (intercepted || patchApplied) return;
        for (let i = pendingGetters.length - 1; i >= 0; i--) {
          try {
            const val = pendingGetters[i]();
            if (val && typeof val === 'function' && val.prototype && isComponentStoreProto(val.prototype)) {
              patchComponentStorePrototype(val);
              intercepted = true;
              pendingGetters.length = 0;
              return;
            }
          } catch (e) { continue; }
        }
      }, 0);
    }

    const handler = {
      apply(target, thisArg, args) {
        const result = Reflect.apply(target, thisArg, args);
        if (intercepted || patchApplied) return result;

        try {
          const descriptor = args[2];
          if (!descriptor) return result;

          if (descriptor.value && typeof descriptor.value === 'function') {
            const val = descriptor.value;
            if (val.prototype && isComponentStoreProto(val.prototype)) {
              patchComponentStorePrototype(val);
              intercepted = true;
              return result;
            }
          }

          if (typeof descriptor.get === 'function') {
            pendingGetters.push(descriptor.get);
            scheduleDeferredCheck();
          }
        } catch (e) {}

        return result;
      },
    };

    try {
      Object.defineProperty = new Proxy(Object.defineProperty, handler);
    } catch (e) {}

    const originalCreate = Object.create;
    Object.create = function (proto, properties) {
      const result = originalCreate.call(this, proto, properties);
      if (!intercepted && !patchApplied && isComponentStoreProto(proto)) {
        const ctor = proto.constructor || Object.getPrototypeOf(proto)?.constructor;
        if (ctor) {
          patchComponentStorePrototype(ctor);
          intercepted = true;
        }
      }
      return result;
    };
  }

  function interceptViaWebpackInjection() {
    const chunkNames = Object.keys(window).filter(key => key.startsWith('webpackChunk'));

    for (const chunkName of chunkNames) {
      const chunkArray = window[chunkName];
      if (!Array.isArray(chunkArray)) continue;

      const originalPush = chunkArray.push.bind(chunkArray);
      chunkArray.push = function (chunk) {
        if (patchApplied) return originalPush(chunk);

        const modules = chunk[1];
        if (modules && typeof modules === 'object') {
          for (const moduleId of Object.keys(modules)) {
            const originalFactory = modules[moduleId];
            if (typeof originalFactory !== 'function') continue;

            modules[moduleId] = function (module, exports, __webpack_require__) {
              originalFactory.call(this, module, exports, __webpack_require__);

              if (!patchApplied && !cachedWebpackRequire && __webpack_require__) {
                cachedWebpackRequire = __webpack_require__;
                interceptWebpackDefineExport(__webpack_require__);
                if (__webpack_require__.c) {
                  scanModuleCache(__webpack_require__.c);
                }
              }

              if (!patchApplied && exports) {
                checkExportsForComponentStore(exports, moduleId);
              }
            };
          }
        }

        return originalPush(chunk);
      };
    }
  }

  function interceptWebpackDefineExport(__webpack_require__) {
    if (!__webpack_require__.d) return;
    const originalD = __webpack_require__.d;
    __webpack_require__.d = function (exports, definition) {
      originalD.call(this, exports, definition);
      if (patchApplied) return;

      for (const key of Object.keys(definition)) {
        try {
          const getter = definition[key];
          if (typeof getter !== 'function') continue;
          const val = getter();
          if (val && typeof val === 'function' && val.prototype && isComponentStoreProto(val.prototype)) {
            patchComponentStorePrototype(val);
          }
        } catch (e) { continue; }
      }
    };
  }

  function checkExportsForComponentStore(exports, moduleId) {
    try {
      for (const key of Object.keys(exports)) {
        const val = exports[key];
        if (val && typeof val === 'function' && val.prototype && isComponentStoreProto(val.prototype)) {
          patchComponentStorePrototype(val);
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  function scanModuleCache(cache) {
    if (patchApplied) return;
    for (const moduleId of Object.keys(cache)) {
      const mod = cache[moduleId];
      if (!mod || !mod.exports) continue;
      if (checkExportsForComponentStore(mod.exports, moduleId)) return;
    }
  }

  // --- Polling fallback ---

  function startPolling() {
    let attempts = 0;
    const intervalId = setInterval(() => {
      attempts++;
      if (patchApplied || attempts >= MAX_POLL_ATTEMPTS) {
        clearInterval(intervalId);
        if (!patchApplied) notifyStatus('no_stores_found', 0);
        return;
      }
      if (!hasReduxDevTools()) {
        clearInterval(intervalId);
        notifyStatus('no_devtools', 0);
        return;
      }
      findAndPatchComponentStore();
    }, POLL_INTERVAL);
  }

  // --- Entry point ---

  function init() {
    if (!hasReduxDevTools()) {
      console.log(
        '%c[NgRx CS DevTools]%c Redux DevTools not detected',
        'color: #7B1FA2; font-weight: bold',
        'color: #F44336'
      );
      notifyStatus('no_devtools', 0);
      return;
    }

    notifyStatus('scanning', 0);
    interceptModuleLoading();
    interceptViaWebpackInjection();

    if (findInWebpackModules()) return;
    startPolling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
