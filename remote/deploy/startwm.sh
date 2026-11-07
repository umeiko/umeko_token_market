#!/bin/sh
# Optional xrdp-only user session, installed as ~/startwm.sh after a backup.
# Keep the physical desktop and its session bus independent.
unset DBUS_SESSION_BUS_ADDRESS SESSION_MANAGER WAYLAND_DISPLAY
export XDG_SESSION_TYPE=x11
export XDG_CURRENT_DESKTOP=MATE
export XDG_SESSION_DESKTOP=mate
export DESKTOP_SESSION=mate
export GDK_BACKEND=x11
export QT_QPA_PLATFORM=xcb
# The virtual xrdp display must work without a monitor or GPU acceleration.
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export __GLX_VENDOR_LIBRARY_NAME=mesa
exec /usr/bin/dbus-run-session -- /usr/bin/mate-session --disable-acceleration-check
