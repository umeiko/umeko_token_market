# Apache Guacamole JavaScript client

`guacamole-common.js` concatenates the 35 JavaScript modules from the official
Apache Guacamole `guacamole-client` tag `1.6.0`, with `Namespace.js` first and
the remaining module filenames in alphabetical order. Trailing whitespace is normalized. Each module retains its
Apache license header. The release's LICENSE and NOTICE are included here.

Source: https://github.com/apache/guacamole-client/tree/1.6.0/guacamole-common-js/src/main/webapp/modules

No scripts are loaded from a CDN. This file is served by the remote service and
does not grant access without a signed login and a one-time desktop ticket.
