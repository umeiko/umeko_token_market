'use strict';
// onEach registers each Guacamole event separately. on(array, callback) would
// instead subscribe to a single comma-joined name, silently dropping all input.
window.UmekoRemoteInput = {
  bindPointer(source, client, focus) {
    const types = ['mousedown', 'mousemove', 'mouseup'];
    const forward = (event) => {
      event.preventDefault();
      if (event.type === 'mousedown') focus();
      client.sendMouseState(event.state, true);
    };
    source.onEach(types, forward);
    return () => {
      source.reset();
      source.offEach(types, forward);
    };
  },
};
