(function (root) {
  'use strict';

  const validNotes = notes => notes && typeof notes === 'object' && !Array.isArray(notes) && Object.entries(notes).every(([id, note]) => /^[a-zA-Z][\w-]*$/.test(id) && typeof note === 'string' && [...note].length <= 2000 && !note.includes('\0'));

  function validState(value) {
    return Boolean(value && Number.isSafeInteger(value.version) && value.version >= 0 &&
      Array.isArray(value.selected_ids) && value.selected_ids.every((id) => typeof id === 'string') &&
      new Set(value.selected_ids).size === value.selected_ids.length &&
      validNotes(value.property_notes) && Object.keys(value.property_notes).every(id => value.selected_ids.includes(id)) &&
      typeof value.notes === 'string' && [...value.notes].length <= 2000 && !value.notes.includes('\0') &&
      (value.updated_at === null || typeof value.updated_at === 'string') &&
      typeof value.csrf_token === 'string' && value.csrf_token.length > 0);
  }

  function createSelectionAdapter({endpoint, csrfHeader = 'X-CSRF-Token', fetchImpl = root.fetch?.bind(root)} = {}) {
    if (typeof endpoint !== 'string' || !/^\/(?!\/)[a-zA-Z0-9/_-]+$/.test(endpoint)) {
      throw new TypeError('Shared feedback endpoint must be a same-origin absolute path');
    }
    if (typeof csrfHeader !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(csrfHeader)) {
      throw new TypeError('CSRF header must be a valid HTTP token');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
    let current = null;

    async function readResponse(response) {
      let value;
      try { value = await response.json(); } catch { return null; }
      return value;
    }

    async function load() {
      try {
        const response = await fetchImpl(endpoint, {method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: {Accept: 'application/json'}});
        const value = await readResponse(response);
        if (response.status === 503) return {status: 'unavailable'};
        if (!response.ok) return {status: 'error', error: value?.error || `http_${response.status}`};
        if (!validState(value)) return {status: 'error', error: 'invalid_response'};
        current = value;
        return {status: 'loaded', state: current};
      } catch {
        return {status: 'unavailable'};
      }
    }

    async function save({selected_ids, notes, property_notes}) {
      if (!current) {
        const loaded = await load();
        if (loaded.status !== 'loaded') return loaded;
      }
      if (!validNotes(property_notes) || Object.keys(property_notes).some(id => !selected_ids?.includes(id)) || !Array.isArray(selected_ids) || !selected_ids.every((id) => typeof id === 'string') ||
          new Set(selected_ids).size !== selected_ids.length || typeof notes !== 'string' ||
          [...notes].length > 2000 || notes.includes('\0')) return {status: 'invalid'};
      try {
        const response = await fetchImpl(endpoint, {
          method: 'PUT',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {'Content-Type': 'application/json', [csrfHeader]: current.csrf_token},
          body: JSON.stringify({version: current.version, selected_ids, notes, property_notes})
        });
        const value = await readResponse(response);
        if (response.status === 409) {
          if (!validState(value?.current)) return {status: 'error', error: 'invalid_conflict'};
          current = value.current;
          return {status: 'conflict', state: current};
        }
        if (response.status === 503) return {status: 'unavailable'};
        if (!response.ok) return {status: 'error', error: value?.error || `http_${response.status}`};
        if (!validState(value)) return {status: 'error', error: 'invalid_response'};
        current = value;
        return {status: 'saved', state: current};
      } catch {
        return {status: 'unavailable'};
      }
    }

    return Object.freeze({load, save});
  }

  root.PresentationSelectionAdapter = Object.freeze({createSelectionAdapter});
})(typeof window === 'undefined' ? globalThis : window);
