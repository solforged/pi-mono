-- Pi Open: receives pi-open:// links that Pi shows, and hands each to open.sh.
on open location theURL
	do shell script "/bin/sh " & quoted form of (POSIX path of (path to resource "open.sh")) & " " & quoted form of theURL
end open location
