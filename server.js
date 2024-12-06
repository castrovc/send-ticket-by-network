const https = require("https");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const { EscPos } = require("@tillpos/xml-escpos-helper");
const connectToPrinter = require("./connectToPrinter");
const logoPath = "./assets/qr.png";
const sharp = require("sharp");
const escpos = require("escpos");
escpos.Network = require("escpos-network");

const getResizedLogoBase64 = async () => {
  return sharp(logoPath)
    .resize(300, 300)
    .toBuffer()
    .then((data) => data.toString("base64"))
    .catch(() => {
      return null;
    });
};
const app = express();
app.use(express.json());
const generateBuffer = (template, data) => {
  return EscPos.getBufferFromTemplate(template, data);
};
const sendMessageToPrinter = async (host, port, message) => {
  try {
    await connectToPrinter(host, port, message);
  } catch (err) {
    console.log("some error", err);
  }
};

const options = {
  key: fs.readFileSync("key.pem"),
  cert: fs.readFileSync("certificate.pem"),
};
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://coffee-place-sv.netlify.app",
    ],
  })
);
https.createServer(options, app).listen(3000, () => {
  console.log("Listening on port 3000");
});

app.post("/print2", async (req, res) => {
  try {
    let {
      details,
      customer,
      total,
      date,
      time,
      tableId,
      employee,
      description,
    } = req.body;

    if (!details || !customer || !total || !date || !time) {
      return res.status(400).send("Missing required fields");
    }

    if (customer === "N/A") {
      customer = "CLIENTE VARIOS";
    }
    if (!tableId) {
      tableId = "DELIVERY";
    }
    if (description === "N/A") {
      description = "SIN COMENTARIOS";
    }

    const foodDetails = details.filter(
      (detail) =>
        detail.branchProduct.product.subCategoryProduct.categoryProduct.name ===
        "Comida"
    );
    const beverageDetails = details.filter(
      (detail) =>
        detail.branchProduct.product.subCategoryProduct.categoryProduct.name ===
        "Bebidas"
    );

    const templateComida = fs.readFileSync("./ticketComida.xml", {
      encoding: "utf8",
    });
    const templateBebida = fs.readFileSync("./ticketBebida.xml", {
      encoding: "utf8",
    });

    const PRINTER = {
      device_name: "SEEDCODE",
      host: "192.168.0.100",
      port: 9100,
    };

    const printTicket = async (filteredDetails, category, template) => {
      const tableData = filteredDetails
        .map((detail) => {
          const productName = detail.branchProduct.product.name.padEnd(20);
          const quantity = String(detail.quantity).padStart(23);

          return `${productName}${quantity}`;
        })
        .join("\n");

      const message = generateBuffer(template, {
        customer,
        total,
        date,
        employee: employee.fullName,
        time,
        description,
        tableData,
        tableId,
        category,
      });

      await sendMessageToPrinter(PRINTER.host, PRINTER.port, message);
    };

    if (foodDetails.length > 0) {
      await printTicket(foodDetails, "Comida", templateComida);
    }

    if (beverageDetails.length > 0) {
      await printTicket(beverageDetails, "Bebidas", templateBebida);
    }

    res.send("success");
  } catch (err) {
    console.log(err);
    res.send("failed");
  }
});

app.post('/print', async (req, res) => {
  try {
    const {
      details,
      branchName,
      totalPagar,
      numeroControl,
      codigoGeneracion,
      box,
      selloRecibido,
      fecEmi,
    } = req.body;

   if (!details || !branchName || !totalPagar || !numeroControl || !codigoGeneracion || !box || !selloRecibido || !fecEmi) {
      return res.status(400).send('Missing required fields');
    }

    // Configuración de la impresora
    const PRINTER = {
      host: '192.168.0.100', // Cambia según tu red
      port: 9100,           // Puerto configurado para la impresora
    };
    const device = new escpos.Network(PRINTER.host, PRINTER.port);
    const printer = new escpos.Printer(device);

    device.open(async (error) => {
      if (error) {
        console.error("Error connecting to printer:", error);
        return res.status(500).send("Printer connection failed");
      }

      // Encabezado del ticket con estilo
      printer
        .align("CT") // Centrar texto
        .style("B") // Negrita
        .size(2, 2) // Doble altura y doble ancho
        .text(branchName) // Nombre de la sucursal
        .style("NORMAL") // Estilo normal
        .size(1, 1) // Tamaño normal
        .text("-----------------------------------------------");

      // Información general con estilo
      printer
        .align("LT") // Alinear a la izquierda
        .style("B") // Negrita
        .text(`Caja: ${box}`)
        .style("NORMAL") // Estilo normal
        .text(`Fecha de compra: ${new Date().toLocaleString()}`)
        .text(`Número de control: ${numeroControl}`)
        .text(`Código Generación: ${codigoGeneracion}`)
        .text(`Sello recibido: ${selloRecibido}`)
        .text("-----------------------------------------------");

      // Títulos de la tabla con estilo
      printer
        .align("CT")
        .style("U") // Subrayado
        .text("Producto             Cantidad   Precio    Total")
        .style("NORMAL")
        .text("-----------------------------------------------");

      // Detalles de productos
      details.forEach((detail) => {
        const productName = detail.descripcion.padEnd(20);
        const quantity = String(detail.cantidad).padStart(6);
        const price = String(detail.precioUni).padStart(11);
        const total = String(detail.ventaGravada).padStart(10);

        printer.text(`${productName}${quantity}${price}${total}`);
      });

      printer.text("-----------------------------------------------");

      printer
        .align("RT")
        .style("B")
        .size(2, 1)
        .text(`TOTAL A PAGAR: $${totalPagar}`)
        .style("NORMAL")
        .size(1, 1);
      printer
        .align("CT")
        .text("Este comprobante no tiene validez tributaria,")
        .text("https://seedcodesv.com/", { size: 4 })
        .text("Escanea el código QR para validar tu DTE")
        .style("B")
        .text("Powered by SeedCodeSV")
        .style("NORMAL")
        .text("www.seedcodesv.com");

      // Corte de papel
      printer.cut();
      printer.close();

      res.send("success");
    });

  } catch (err) {
    console.error("Error while printing:", err);
    res.status(500).send("Printing failed");
  }
});

app.post("/sale", async (req, res) => {
  try {
    const logoBase64 = await getResizedLogoBase64();
    let {
      details,
      customer,
      total,
      date,
      time,
      tableId,
      address,
      name,
      phone,
    } = req.body;

    // Validaciones para customer y tableId
    if (customer === "N/A") {
      customer = "CLIENTE VARIOS";
    }
    if (!tableId) {
      tableId = "DELIVERY";
    }

    if (!details || !customer || !total || !date || !time) {
      return res.status(400).send("Missing required fields");
    }

    const template = fs.readFileSync("./ticket.xml", {
      encoding: "utf8",
    });

    const PRINTER = {
      device_name: "SEEDCODE",
      host: "192.168.0.100",
      port: 9100,
    };

    const printTicket = async (filteredDetails, template) => {
      const tableData = filteredDetails
        .map((detail) => {
          const productName = detail.branchProduct.product.name.padEnd(20);
          const quantity = String(detail.quantity).padStart(6);
          const price = `${String("$" + detail.branchProduct.price).padStart(
            11
          )}`;
          const total = `${String("$" + detail.totalUnit).padStart(10)}`;

          return `${productName}${quantity}${price}${total}`;
        })
        .join("\n");

      const message = generateBuffer(template, {
        customer,
        total,
        date,
        time,
        address,
        name,
        phone,
        tableId,
        tableData,
        logo: logoBase64,
      });

      await sendMessageToPrinter(PRINTER.host, PRINTER.port, message);
    };

    await printTicket(details, template);

    res.send("success");
  } catch (err) {
    console.log(err);
    res.send("failed");
  }
});

app.post("/printName", async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).send("Missing required field: name");
    }

    const template = fs.readFileSync("./test.xml", { encoding: "utf8" });

    const message = generateBuffer(template, { name });

    const PRINTER = {
      device_name: "SEEDCODE",
      host: "192.168.0.100",
      port: 9100,
    };

    await sendMessageToPrinter(PRINTER.host, PRINTER.port, message);

    res.send("Ticket imprimido con éxito");
  } catch (err) {
    console.error("Error al imprimir:", err);
    res.status(500).send("Error al imprimir el ticket");
  }
});

app.post('/printsecond', async (req, res) => {
  try {
    const {
      codigoGeneracion,
      fecEmi,
    } = req.body;

    console.log(codigoGeneracion,fecEmi);


    if ( !codigoGeneracion || !fecEmi) {
      return res.status(400).send('Missing required fields');
    }

// const qrImage = await QR_URL(codigoGeneracion,fecEmi);

// if (!qrImage) {
//   return res.status(500).send("Error generando el código QR");
// }

// const qrImage = await generateQRCode(`https://admin.factura.gob.sv/consultaPublica?ambiente=${encodeURIComponent("00")}&codGen=${encodeURIComponent(codigoGeneracion)}&fechaEmi=${encodeURIComponent(fecEmi)}`)
const qrImage = `https://admin.factura.gob.sv/consultaPublica?ambiente=${encodeURIComponent("00")}&codGen=${encodeURIComponent(codigoGeneracion)}&fechaEmi=${encodeURIComponent(fecEmi)}`


console.log("QR generado:", qrImage);



    const PRINTER = {
      host: '192.168.0.100', // Cambia según tu red
      port: 9100,           // Puerto configurado para la impresora
    };
    const device = new escpos.Network(PRINTER.host, PRINTER.port);
    const printer = new escpos.Printer(device);

    device.open(function(error){
      printer
      .font('a')
      .align('ct')
      .style('bu')
      .size(1, 1)
      .text('The quick brown fox jumps over the lazy dog')
      .text('敏捷的棕色狐狸跳过懒狗')
      .barcode('1234567', 'EAN8')
      .table(["One", "Two", "Three"])
      .tableCustom(
        [
          { text:"Left", align:"LEFT", width:0.33, style: 'B' },
          { text:"Center", align:"CENTER", width:0.33},
          { text:"Right", align:"RIGHT", width:0.33 }
        ],
        { encoding: 'cp857', size: [1, 1] } // Optional
      )
      .qrimage(qrImage, function(err){
        this.cut();
        this.close();
      });
    });
    
    res.send("Ticket imprimido con éxito");
  } catch (err) {
    console.error("Error while printing:", err);
    res.status(500).send("Printing failed");
  }
});