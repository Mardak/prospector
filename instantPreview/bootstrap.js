/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Instant Preview.
 *
 * The Initial Developer of the Original Code is The Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Edward Lee <edilee@mozilla.com>
 *   Erik Vold <erikvvold@gmail.com>
 *   Greg Parris <greg.parris@gmail.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const {interfaces: Ci, utils: Cu} = Components;
Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource://gre/modules/Services.jsm");

// Track the top urls to preview instantly without waiting
let topUrls = [];

/**
 * Start showing a preview of the selected location bar suggestion
 */
function addPreviews(window) {
  let browser = window.gBrowser;
  let urlBar = window.gURLBar;
  let popup = urlBar.popup;
  let richBox = popup.richlistbox;

  // Shorten the results so that previews are visible
  let origRows = urlBar.getAttribute("maxrows");
  urlBar.setAttribute("maxrows", 3);
  unload(function() urlBar.setAttribute("maxrows", origRows), window);

  let preview;
  // Provide a way to get rid of the preview from the current tab
  function removePreview() {
    if (preview != null) {
      preview.parentNode.removeChild(preview);
      preview = null;
    }
  }

  // Provide a way to replace the current tab with the preview
  function persistPreview() {
    if (preview == null)
      return;

    // Mostly copied from tabbrowser.xml swapBrowsersAndCloseOther
    let selectedTab = browser.selectedTab;
    let selectedBrowser = selectedTab.linkedBrowser;
    selectedBrowser.stop();

    // Unhook our progress listener
    let selectedIndex = selectedTab._tPos;
    const filter = browser.mTabFilters[selectedIndex];
    let tabListener = browser.mTabListeners[selectedIndex];
    selectedBrowser.webProgress.removeProgressListener(filter);
    filter.removeProgressListener(tabListener);
    let tabListenerBlank = tabListener.mBlank;

    // Pick out the correct interface for before/after Firefox 4b8pre
    let openPage = browser.mBrowserHistory || browser._placesAutocomplete;

    // Restore current registered open URI.
    if (selectedBrowser.registeredOpenURI) {
      openPage.unregisterOpenPage(selectedBrowser.registeredOpenURI);
      delete selectedBrowser.registeredOpenURI;
    }
    openPage.registerOpenPage(preview.currentURI);
    selectedBrowser.registeredOpenURI = preview.currentURI;

    // Save the last history entry from the preview if it has loaded
    let history = preview.sessionHistory.QueryInterface(Ci.nsISHistoryInternal);
    let entry;
    if (history.count > 0) {
      entry = history.getEntryAtIndex(history.index, false);
      history.PurgeHistory(history.count);
    }

    // Copy over the history from the current tab if it's not empty
    let origHistory = selectedBrowser.sessionHistory;
    for (let i = 0; i <= origHistory.index; i++) {
      let origEntry = origHistory.getEntryAtIndex(i, false);
      if (origEntry.URI.spec != "about:blank")
        history.addEntry(origEntry, true);
    }

    // Add the last entry from the preview; in-progress preview will add itself
    if (entry != null)
      history.addEntry(entry, true);

    // Swap the docshells then fix up various properties
    selectedBrowser.swapDocShells(preview);
    selectedBrowser.attachFormFill();
    browser.setTabTitle(selectedTab);
    browser.updateCurrentBrowser(true);
    browser.useDefaultIcon(selectedTab);
    urlBar.value = (selectedBrowser.currentURI.spec != "about:blank") ?
        selectedBrowser.currentURI.spec : preview.getAttribute("src");

    // Restore the progress listener
    tabListener = browser.mTabProgressListener(selectedTab, selectedBrowser, tabListenerBlank);
    browser.mTabListeners[selectedIndex] = tabListener;
    filter.addProgressListener(tabListener, Ci.nsIWebProgress.NOTIFY_ALL);
    selectedBrowser.webProgress.addProgressListener(filter, Ci.nsIWebProgress.NOTIFY_ALL);

    // Move focus out of the preview to the tab's browser before removing it
    preview.blur();
    selectedBrowser.focus();
    removePreview();
  }

  // Provide callbacks to stop checking the popup
  let stop = false;
  function stopIt() stop = true;
  unload(function() {
    stopIt();
    removePreview();
  }, window);

  // Track what delayed url and when to load it
  let delayedUrl, delayUntil;

  // Keep checking if the popup has something to preview
  listen(window, popup, "popuphidden", stopIt);
  listen(window, popup, "popupshown", function() {
    // Only recursively go again for a repeating check if not stopping
    if (stop) {
      stop = false;
      return;
    }
    Utils.delay(arguments.callee, 100);

    // Short circuit if there's no suggestions but don't remove the preview
    if (!urlBar.popupOpen)
      return;

    // Make sure we have something selected to show
    let result = richBox.selectedItem;
    if (result == null) {
      removePreview();
      return;
    }

    // Only auto-load some types of uris
    let url = result.getAttribute("url");
    if (url.search(/^(data|ftp|https?):/) == -1) {
      removePreview();
      return;
    }

    // Create the preview if it's missing
    if (preview == null) {
      preview = window.document.createElement("browser");
      preview.setAttribute("type", "content");

      // Copy some inherit properties of normal tabbrowsers
      preview.setAttribute("autocompletepopup", browser.getAttribute("autocompletepopup"));
      preview.setAttribute("contextmenu", browser.getAttribute("contentcontextmenu"));
      preview.setAttribute("tooltip", browser.getAttribute("contenttooltip"));

      // Prevent title changes from showing during a preview
      preview.addEventListener("DOMTitleChanged", function(e) e.stopPropagation(), true);

      // The user clicking or tabbinb to the content should indicate persist
      preview.addEventListener("focus", persistPreview, true);
    }

    // Move the preview to the current tab if switched
    let selectedStack = browser.selectedBrowser.parentNode;
    if (selectedStack != preview.parentNode)
      selectedStack.appendChild(preview);

    // Only bother loading the url if new
    if (preview.getAttribute("src") == url)
      return;

    // If we don't want to show the preview immediately..
    if (result.getAttribute("type") == "favicon" && topUrls.indexOf(url) == -1) {
      let now = Date.now();

      // Wait some more for the same url if we haven't waited long enough
      if (url == delayedUrl && now < delayUntil)
        return;
      // Got a new url to delay, so track a new time to wait until
      else if (url != delayedUrl) {
        delayedUrl = url;
        delayUntil = now + 5000;
        return;
      }
    }

    // Must have waited long enough or no need to delay
    delayedUrl = null;
    delayUntil = null;

    preview.setAttribute("src", url);
  });

  // Make the preview permanent on enter
  listen(window, urlBar, "keypress", function(event) {
    switch (event.keyCode) {
      case event.DOM_VK_ENTER:
      case event.DOM_VK_RETURN:
        // Only use the preview if there aren't special key combinations
        if (event.shiftKey || event.ctrlKey || event.metaKey)
          removePreview();
        else
          persistPreview();
        break;

      // Remove the preview on cancel or edits
      case event.DOM_VK_CANCEL:
      case event.DOM_VK_ESCAPE:
      case event.DOM_VK_BACK_SPACE:
      case event.DOM_VK_DELETE:
      case event.DOM_VK_END:
      case event.DOM_VK_HOME:
      case event.DOM_VK_LEFT:
      case event.DOM_VK_RIGHT:
        removePreview();
        break;
    }
  });

  // Clicking a result will save the preview
  listen(window, popup, "click", persistPreview);
}

/**
 * Apply a callback to each open and new browser windows.
 *
 * @usage watchWindows(callback): Apply a callback to each browser window.
 * @param [function] callback: 1-parameter function that gets a browser window.
 */
function watchWindows(callback) {
  // Wrap the callback in a function that ignores failures
  function watcher(window) {
    try {
      callback(window);
    }
    catch(ex) {}
  }

  // Wait for the window to finish loading before running the callback
  function runOnLoad(window) {
    // Listen for one load event before checking the window type
    window.addEventListener("load", function() {
      window.removeEventListener("load", arguments.callee, false);

      // Now that the window has loaded, only handle browser windows
      let doc = window.document.documentElement;
      if (doc.getAttribute("windowtype") == "navigator:browser")
        watcher(window);
    }, false);
  }

  // Add functionality to existing windows
  let browserWindows = Services.wm.getEnumerator("navigator:browser");
  while (browserWindows.hasMoreElements()) {
    // Only run the watcher immediately if the browser is completely loaded
    let browserWindow = browserWindows.getNext();
    if (browserWindow.document.readyState == "complete")
      watcher(browserWindow);
    // Wait for the window to load before continuing
    else
      runOnLoad(browserWindow);
  }

  // Watch for new browser windows opening then wait for it to load
  function windowWatcher(subject, topic) {
    if (topic == "domwindowopened")
      runOnLoad(subject);
  }
  Services.ww.registerNotification(windowWatcher);

  // Make sure to stop watching for windows if we're unloading
  unload(function() Services.ww.unregisterNotification(windowWatcher));
}

/**
 * Save callbacks to run when unloading. Optionally scope the callback to a
 * container, e.g., window. Provide a way to run all the callbacks.
 *
 * @usage unload(): Run all callbacks and release them.
 *
 * @usage unload(callback): Add a callback to run on unload.
 * @param [function] callback: 0-parameter function to call on unload.
 * @return [function]: A 0-parameter function that undoes adding the callback.
 *
 * @usage unload(callback, container) Add a scoped callback to run on unload.
 * @param [function] callback: 0-parameter function to call on unload.
 * @param [node] container: Remove the callback when this container unloads.
 * @return [function]: A 0-parameter function that undoes adding the callback.
 */
function unload(callback, container) {
  // Initialize the array of unloaders on the first usage
  let unloaders = unload.unloaders;
  if (unloaders == null)
    unloaders = unload.unloaders = [];

  // Calling with no arguments runs all the unloader callbacks
  if (callback == null) {
    unloaders.slice().forEach(function(unloader) unloader());
    unloaders.length = 0;
    return;
  }

  // The callback is bound to the lifetime of the container if we have one
  if (container != null) {
    // Remove the unloader when the container unloads
    container.addEventListener("unload", removeUnloader, false);

    // Wrap the callback to additionally remove the unload listener
    let origCallback = callback;
    callback = function() {
      container.removeEventListener("unload", removeUnloader, false);
      origCallback();
    }
  }

  // Wrap the callback in a function that ignores failures
  function unloader() {
    try {
      callback();
    }
    catch(ex) {}
  }
  unloaders.push(unloader);

  // Provide a way to remove the unloader
  function removeUnloader() {
    let index = unloaders.indexOf(unloader);
    if (index != -1)
      unloaders.splice(index, 1);
  }
  return removeUnloader;
}

/**
 * Handle the add-on being activated on install/enable
 */
function startup(data, reason) AddonManager.getAddonByID(data.id, function(addon) {
  Cu.import("resource://services-sync/util.js");
  watchWindows(addPreviews);

  // XXX Force a QI until bug 609139 is fixed
  Svc.History.QueryInterface(Ci.nsPIPlacesDatabase);

  let query = "SELECT * " +
              "FROM moz_places " +
              "ORDER BY frecency DESC " +
              "LIMIT 100";
  let cols = ["url"];
  let stmt = Utils.createStatement(Svc.History.DBConnection, query);
  Utils.queryAsync(stmt, cols).forEach(function({url}) {
    topUrls.push(url);
  });
});

/**
 * Handle the add-on being deactivated on uninstall/disable
 */
function shutdown(data, reason) {
  // Clean up with unloaders when we're deactivating
  if (reason != APP_SHUTDOWN)
    unload();
}

/**
 * Helper that adds event listeners and remembers to remove on unload
 */
function listen(window, node, event, func) {
  node.addEventListener(event, func, true);
  unload(function() node.removeEventListener(event, func, true), window);
}

function install() {}
function uninstall() {}
