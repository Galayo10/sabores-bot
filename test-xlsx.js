import XLSX from 'xlsx';

// Abrir el Excel
const workbook = XLSX.readFile('productos.xlsx');
const sheet = workbook.Sheets[workbook.SheetNames[0]];

// Convertir la hoja a JSON
const data = XLSX.utils.sheet_to_json(sheet);

// Mostrar el contenido en consola
console.log("Contenido del Excel:");
console.log(data);