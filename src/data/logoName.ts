// CON, PRN, AUX, NUL, COM1… LPT9 are device names on Windows: no file may be called
// CON.DE.png there (Continental), and git refuses it. Such logos are stored with a leading "_".
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

// logo key ("CON.DE") -> file name under public/logos/<dir> without .png ("_CON.DE")
export const logoFileName = (name: string) => (RESERVED.test(name) ? `_${name}` : name);

// and back, for the list of files on disk
export const logoKeyOfFile = (file: string) => (file.startsWith('_') && RESERVED.test(file.slice(1)) ? file.slice(1) : file);
