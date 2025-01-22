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
require("dotenv").config();

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

app.post("/print", async (req, res) => {
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
      customer,
      subTotalConIvaIncluido,
      typeDte,
    } = req.body;

    // Validar campos requeridos
    if (
      !details ||
      !branchName ||
      !totalPagar ||
      !box ||
      !fecEmi ||
      !subTotalConIvaIncluido ||
      !typeDte
    ) {
      return res.status(400).send("Missing required fields");
    }

    const typeFactura =
      typeDte === "01" ? "CONSUMIDOR FINAL" : "CREDITO FISCAL";
    const selloValidado = selloRecibido || "N/A";

    const PRINTER = {
      host: process.env.HOST,
      port: 9100,
    };
    const device = new escpos.Network(PRINTER.host, PRINTER.port);
    const printer = new escpos.Printer(device);

    // Abrir conexión con la impresora
    device.open(async (error) => {
      if (error) {
        console.error("Error connecting to printer:", error);
        return res.status(500).send("Printer connection failed");
      }

      try {
        // Imprimir cabecera
        printer
          .align("CT")
          .style("B")
          .size(0, 0)
          .text(branchName)
          .style("NORMAL")
          .text("-----------------------------------------------")
          .align("CT")
          .text(`DTE : ${typeFactura}`)
          .text(`Caja: ${box}`)
          .text(`Fecha de compra: ${fecEmi}`);

        if (selloValidado !== "N/A") {
          printer.text(`Numero de control: ${numeroControl}`);
          printer.text(`Codigo Generacion: ${codigoGeneracion}`);
        }

        printer.text(`Sello recibido: ${selloValidado}`);
        printer.text(`Cliente: ${customer || "CLIENTE VARIOS"}`);
        printer.text("-----------------------------------------------");

        // Imprimir detalles
        printer
          .align("CT")
          .text("Producto             Cantidad   Precio    Total")
          .text("-----------------------------------------------");

        details.forEach((detail) => {
          const productName = String(detail.descripcion);
          const quantity = String(detail.cantidad).padStart(8).padEnd(12);
          const price = `$${Number(detail.precioUni).toFixed(2)}`
            .padStart(6)
            .padEnd(9);
          const total = `$${Number(detail.ventaGravada).toFixed(2)}`.padStart(
            6
          );

          if (productName.length > 19) {
            const firstPart = productName.slice(0, 19);
            const secondPart = productName.slice(19);

            printer
              .encode("CP850")
              .text(`${firstPart.padEnd(19)}${quantity}${price}${total}`)
              .align("LT")
              .text(`${secondPart.padEnd(19)}`);
          } else {
            const paddedName = productName.padEnd(19);
            printer
              .encode("CP850")
              .text(`${paddedName}${quantity}${price}${total}`);
          }
        });

        printer.text("-----------------------------------------------");

        // Imprimir totales
        printer
          .align("RT")
          .style("B")
          .text(`SUBTOTAL: $${totalPagar}`)
          .text(`TOTAL A PAGAR: $${subTotalConIvaIncluido}`)
          .style("NORMAL");

        if (selloValidado !== "N/A") {
          const qrImage = `https://admin.factura.gob.sv/consultaPublica?ambiente=${encodeURIComponent(
            "01"
          )}&codGen=${encodeURIComponent(
            codigoGeneracion
          )}&fechaEmi=${encodeURIComponent(fecEmi)}`;

          await new Promise((resolve, reject) => {
            printer.qrimage(qrImage, (err) => {
              if (err) {
                console.error("Error generating QR:", err);
                reject(err);
              } else {
                resolve();
              }
            });
          });

          printer.text("Escanea el codigo QR para validar tu DTE");
        }

        // Finalizar impresión
        printer
          .style("B")
          .text("Powered by SeedCodeSV")
          .style("NORMAL")
          .text("www.seedcodesv.com")
          .feed(3)
          .cut()
          .close();

        res.send("success");
      } catch (printError) {
        console.error("Printing error:", printError);
        res.status(500).send("Printing failed");
      }
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
      host: process.env.HOST,
      port: 9100,
    };

    await sendMessageToPrinter(PRINTER.host, PRINTER.port, message);

    res.send("Ticket imprimido con éxito");
  } catch (err) {
    console.error("Error al imprimir:", err);
    res.status(500).send("Error al imprimir el ticket");
  }
});

app.post("/printsecond", async (req, res) => {
  try {
    const { codigoGeneracion, fecEmi } = req.body;

    console.log(codigoGeneracion, fecEmi);

    if (!codigoGeneracion || !fecEmi) {
      return res.status(400).send("Missing required fields");
    }

    // const qrImage = await QR_URL(codigoGeneracion,fecEmi);

    // if (!qrImage) {
    //   return res.status(500).send("Error generando el código QR");
    // }

    // const qrImage = await generateQRCode(`https://admin.factura.gob.sv/consultaPublica?ambiente=${encodeURIComponent("00")}&codGen=${encodeURIComponent(codigoGeneracion)}&fechaEmi=${encodeURIComponent(fecEmi)}`)
    const qrImage = `https://admin.factura.gob.sv/consultaPublica?ambiente=${encodeURIComponent(
      "01"
    )}&codGen=${encodeURIComponent(
      codigoGeneracion
    )}&fechaEmi=${encodeURIComponent(fecEmi)}`;

    console.log("QR generado:", qrImage);

    const PRINTER = {
      host: process.env.HOST,
      port: 9100, // Puerto configurado para la impresora
    };
    console.log(process.env.HOST);
    const device = new escpos.Network(PRINTER.host, PRINTER.port);
    const printer = new escpos.Printer(device);

    device.open(function (error) {
      printer
        .font("a")
        .align("ct")
        .style("bu")
        .size(0, 0)
        .qrimage(qrImage, function (err) {
          if (err) {
            console.error("Error generating QR:", err);
          }
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
