import dbus, dbus.service, dbus.mainloop.glib
from gi.repository import GLib
dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
name = dbus.service.BusName('org.mpris.MediaPlayer2.fakeplayer', bus)
class P(dbus.service.Object):
    status = 'Playing'
    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='ss', out_signature='v')
    def Get(self, iface, prop):
        return dbus.String(self.status)
    @dbus.service.method('org.mpris.MediaPlayer2.Player')
    def Pause(self): self.status = 'Paused'
    @dbus.service.method('org.mpris.MediaPlayer2.Player')
    def Play(self): self.status = 'Playing'
P(bus, '/org/mpris/MediaPlayer2')
print('ready', flush=True)
GLib.MainLoop().run()
