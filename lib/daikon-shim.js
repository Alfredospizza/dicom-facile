// Il bundle di daikon 1.2.46 è compilato per Node: collega i suoi moduli interni (anche in modo
// pigro, durante la decodifica) solo se `require` esiste. Questo segnaposto lo rende usabile nel
// browser; non carica nulla: se qualcuno lo chiamasse davvero, darebbe errore.
window.require = function (name) { throw new Error('require non disponibile nel browser: ' + name); };
