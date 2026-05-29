/**
 * Générateur d'attestation d'assurance chasse (PDF)
 *
 * Usage :
 *   const { generateAttestation } = require('./_attestation');
 *   const buffer = await generateAttestation({
 *     policyNumber: 'ADC-2026-A3F9C2',
 *     issueDate: new Date(),
 *     validFrom: new Date(),
 *     validUntil: new Date('2027-06-30'),
 *     customer: { nom, prenom, ddn, adresse, email, tel, npermis },
 *     department: 'gironde',
 *     fdcShort: 'FDC33',
 *     saison: '2026-2027',
 *     options: ['sec', 'chi'],
 *     chiens: [{ nom, race, age, identification, type }],
 *     montants: { securite: 25, chiensPetit: 45, chiensGros: 0, admin: 2, total: 72 },
 *   });
 */
const PDFDocument = require('pdfkit');

const COLORS = {
  marine: '#0d1b4b',
  vert: '#2d6a3f',
  vertClair: '#6abf7b',
  ambre: '#8b5e0a',
  ambreClair: '#f5e6c0',
  beige: '#faf6ee',
  gris: '#5a6a4e',
  noir: '#1a2e0a',
  blanc: '#ffffff',
};

const OPTION_LABEL = {
  sec: 'Sécurité chasse — assurance corporelle du chasseur',
  chi: 'Assurance blessure des chiens de chasse',
};

const FDC_BY_DEPT = {
  gironde: { code: '33', short: 'FDC33', name: 'Fédération Départementale des Chasseurs de la Gironde' },
  calvados: { code: '14', short: 'FDC14', name: 'Fédération Départementale des Chasseurs du Calvados' },
  dordogne: { code: '24', short: 'FDC24', name: 'Fédération Départementale des Chasseurs de la Dordogne' },
  'lot-et-garonne': { code: '47', short: 'FDC47', name: 'Fédération Départementale des Chasseurs du Lot-et-Garonne' },
};

function fmtDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return '—';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(2).replace('.', ',') + ' €';
}

function generatePolicyNumber(sessionId) {
  const year = new Date().getFullYear();
  const suffix = (sessionId || Math.random().toString(36)).replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase();
  return `ADC-${year}-${suffix}`;
}

function generateAttestation(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0, info: {
        Title: `Attestation d'assurance chasse — ${data.policyNumber}`,
        Author: 'Cabinet ADC&E Assurances',
        Subject: `Attestation d'assurance chasse saison ${data.saison || ''}`,
        Creator: 'ADC&E',
      }});

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width;   // 595.28
      const H = doc.page.height;  // 841.89
      const MARGIN_X = 40;

      // ===== BANDEAU EN-TÊTE =====
      doc.rect(0, 0, W, 110).fill(COLORS.marine);
      doc.rect(0, 110, W, 4).fill(COLORS.vert);

      // Logo / marque (texte stylisé)
      doc.fillColor(COLORS.blanc)
         .font('Helvetica-Bold').fontSize(22)
         .text('Cabinet ADC&E', MARGIN_X, 28, { lineBreak: false });
      doc.fillColor(COLORS.vertClair)
         .font('Helvetica').fontSize(10)
         .text('Assurances Chasse', MARGIN_X, 56, { lineBreak: false });
      doc.fillColor('#8aaac8')
         .fontSize(8)
         .text('Avec ADCE, Chassez Heureux', MARGIN_X, 72, { lineBreak: false });

      // Bloc « N° de police » à droite
      const boxX = W - MARGIN_X - 200;
      doc.roundedRect(boxX, 24, 200, 70, 6).fill('#ffffff20');
      doc.fillColor('#8aaac8').font('Helvetica').fontSize(8)
         .text('N° DE POLICE', boxX + 12, 32);
      doc.fillColor(COLORS.blanc).font('Helvetica-Bold').fontSize(13)
         .text(data.policyNumber, boxX + 12, 44);
      doc.fillColor('#8aaac8').font('Helvetica').fontSize(8)
         .text('ÉMISE LE', boxX + 12, 68);
      doc.fillColor(COLORS.blanc).font('Helvetica').fontSize(10)
         .text(fmtDate(data.issueDate), boxX + 12, 78);

      // ===== TITRE PRINCIPAL =====
      let y = 140;
      doc.fillColor(COLORS.noir).font('Helvetica-Bold').fontSize(18)
         .text('ATTESTATION D’ASSURANCE COMPLÉMENTAIRE CHASSE', MARGIN_X, y, {
           width: W - 2 * MARGIN_X, align: 'center',
         });
      y += 28;
      doc.fillColor(COLORS.gris).font('Helvetica').fontSize(11)
         .text(`Saison cynégétique ${data.saison || '—'}`, MARGIN_X, y, {
           width: W - 2 * MARGIN_X, align: 'center',
         });
      y += 30;

      // ===== ENCART VALIDITÉ =====
      doc.roundedRect(MARGIN_X, y, W - 2 * MARGIN_X, 50, 6)
         .fillAndStroke(COLORS.beige, '#d0c8a0');
      doc.fillColor(COLORS.ambre).font('Helvetica-Bold').fontSize(9)
         .text('PÉRIODE DE VALIDITÉ', MARGIN_X + 16, y + 10);
      doc.fillColor(COLORS.noir).font('Helvetica-Bold').fontSize(13)
         .text(`Du ${fmtDate(data.validFrom)} au ${fmtDate(data.validUntil)}`, MARGIN_X + 16, y + 24);
      y += 70;

      // ===== ASSURÉ =====
      doc.fillColor(COLORS.vert).font('Helvetica-Bold').fontSize(10)
         .text('ASSURÉ', MARGIN_X, y);
      doc.moveTo(MARGIN_X, y + 14).lineTo(W - MARGIN_X, y + 14).lineWidth(0.5).stroke(COLORS.vert);
      y += 22;

      const c = data.customer || {};
      const labelW = 110;
      const lineH = 16;
      const drawField = (label, value) => {
        doc.fillColor(COLORS.gris).font('Helvetica').fontSize(9)
           .text(label, MARGIN_X, y, { width: labelW });
        doc.fillColor(COLORS.noir).font('Helvetica-Bold').fontSize(10)
           .text(value || '—', MARGIN_X + labelW, y, { width: W - 2 * MARGIN_X - labelW });
        y += lineH;
      };

      drawField('Nom, prénom', `${c.nom || '—'} ${c.prenom || ''}`.trim());
      if (c.ddn) drawField('Date de naissance', c.ddn);
      drawField('Adresse postale', c.adresse);
      drawField('Email', c.email);
      if (c.tel) drawField('Téléphone', c.tel);
      drawField('N° de permis de chasse', c.npermis);
      const fdc = FDC_BY_DEPT[data.department] || { short: '—', name: '—' };
      drawField('Fédération de validation', fdc.short);
      y += 8;

      // ===== GARANTIES SOUSCRITES =====
      doc.fillColor(COLORS.vert).font('Helvetica-Bold').fontSize(10)
         .text('GARANTIES SOUSCRITES', MARGIN_X, y);
      doc.moveTo(MARGIN_X, y + 14).lineTo(W - MARGIN_X, y + 14).lineWidth(0.5).stroke(COLORS.vert);
      y += 22;

      const opts = Array.isArray(data.options) ? data.options : [];

      if (opts.includes('sec')) {
        doc.roundedRect(MARGIN_X, y, W - 2 * MARGIN_X, 56, 6)
           .fillAndStroke('#f5fbf0', '#c8d8b8');
        doc.fillColor(COLORS.vert).font('Helvetica-Bold').fontSize(11)
           .text('Option 1 — Sécurité chasse', MARGIN_X + 14, y + 10);
        doc.fillColor(COLORS.noir).font('Helvetica').fontSize(9)
           .text('Garantie corporelle du chasseur (blessures, décès, ITT, invalidité)', MARGIN_X + 14, y + 26, { width: W - 2 * MARGIN_X - 28 });
        doc.fillColor(COLORS.gris).font('Helvetica-Oblique').fontSize(8)
           .text('Assureur : Allianz — gérée par le Cabinet Poncey Lebas', MARGIN_X + 14, y + 40);
        y += 66;
      }

      if (opts.includes('chi') && Array.isArray(data.chiens) && data.chiens.length > 0) {
        const cardH = 32 + data.chiens.length * 14 + 20;
        doc.roundedRect(MARGIN_X, y, W - 2 * MARGIN_X, cardH, 6)
           .fillAndStroke('#f5fbf0', '#c8d8b8');
        doc.fillColor(COLORS.vert).font('Helvetica-Bold').fontSize(11)
           .text('Option 2 — Assurance blessure des chiens de chasse', MARGIN_X + 14, y + 10);
        doc.fillColor(COLORS.gris).font('Helvetica-Oblique').fontSize(8)
           .text('Garantie blessures uniquement — la mortalité n’est pas couverte', MARGIN_X + 14, y + 26);
        let cy = y + 42;
        for (const dog of data.chiens) {
          const typeLabel = dog.type === 'petit' ? 'petits gibiers' : dog.type === 'gros' ? 'gros gibiers' : '—';
          const txt = `• ${dog.nom || 'Chien'}${dog.race ? ` (${dog.race})` : ''} — ${dog.age || '?'} ans — ${typeLabel} — id. ${dog.identification || '—'}`;
          doc.fillColor(COLORS.noir).font('Helvetica').fontSize(9)
             .text(txt, MARGIN_X + 14, cy, { width: W - 2 * MARGIN_X - 28 });
          cy += 14;
        }
        doc.fillColor(COLORS.gris).font('Helvetica-Oblique').fontSize(8)
           .text('Assureur : MIC Insurance Company — distribué par ELKYIA / Finaxy Group', MARGIN_X + 14, cy);
        y += cardH + 10;
      }

      // ===== COTISATION =====
      doc.fillColor(COLORS.vert).font('Helvetica-Bold').fontSize(10)
         .text('COTISATION', MARGIN_X, y);
      doc.moveTo(MARGIN_X, y + 14).lineTo(W - MARGIN_X, y + 14).lineWidth(0.5).stroke(COLORS.vert);
      y += 22;

      const m = data.montants || {};
      const drawRow = (label, value, bold) => {
        doc.fillColor(COLORS.noir).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10)
           .text(label, MARGIN_X, y, { width: 320 });
        doc.text(value, MARGIN_X + 320, y, { width: W - 2 * MARGIN_X - 320, align: 'right' });
        y += 16;
      };
      if (m.securite) drawRow('Sécurité chasse', fmtMoney(m.securite));
      if (m.chiensPetit) drawRow('Chiens petits gibiers', fmtMoney(m.chiensPetit));
      if (m.chiensGros) drawRow('Chiens gros gibiers', fmtMoney(m.chiensGros));
      if (m.admin) drawRow('Frais administratifs', fmtMoney(m.admin));
      doc.moveTo(MARGIN_X, y + 2).lineTo(W - MARGIN_X, y + 2).lineWidth(0.5).stroke('#c0c8b8');
      y += 8;
      doc.fillColor(COLORS.vert).font('Helvetica-Bold').fontSize(12);
      drawRow('TOTAL réglé', fmtMoney(m.total), true);
      doc.fillColor(COLORS.gris).font('Helvetica-Oblique').fontSize(8)
         .text('Paiement confirmé par Stripe le ' + fmtDate(data.issueDate), MARGIN_X, y);
      y += 24;

      // ===== MENTIONS LÉGALES + CACHET =====
      const footerY = H - 130;

      // Bloc cachet (à droite)
      doc.roundedRect(W - MARGIN_X - 150, footerY, 150, 70, 6)
         .lineWidth(1).stroke('#c0c8b8');
      doc.fillColor(COLORS.gris).font('Helvetica').fontSize(8)
         .text('Pour le Cabinet ADC&E', W - MARGIN_X - 145, footerY + 8, { width: 140, align: 'center' });
      doc.fillColor(COLORS.vert).font('Helvetica-BoldOblique').fontSize(11)
         .text('Cabinet ADC&E', W - MARGIN_X - 145, footerY + 26, { width: 140, align: 'center' });
      doc.fillColor(COLORS.gris).font('Helvetica').fontSize(7)
         .text(`Bordeaux, le ${fmtDate(data.issueDate)}`, W - MARGIN_X - 145, footerY + 50, { width: 140, align: 'center' });

      // Mentions à gauche
      doc.fillColor(COLORS.gris).font('Helvetica-Bold').fontSize(8)
         .text('Mentions légales', MARGIN_X, footerY);
      doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.gris)
         .text(
           'Cabinet ADC&E Assurances — Courtier en assurances inscrit à l’ORIAS sous le n° 21006219 (orias.fr). ' +
           'Cette attestation est délivrée à titre de complément à la responsabilité civile chasse souscrite auprès de la fédération départementale. ' +
           'Elle ne se substitue pas aux conditions générales et notices d’information remises à l’assuré, qui restent seules opposables. ' +
           'Cabinet Poncey Lebas (ORIAS 07022305-12066667) — Allianz IARD pour l’assurance Sécurité chasse.',
           MARGIN_X, footerY + 12, { width: W - 2 * MARGIN_X - 170, align: 'justify' }
         );

      // ===== BANDEAU PIED DE PAGE =====
      doc.rect(0, H - 40, W, 40).fill(COLORS.marine);
      doc.fillColor('#8aaac8').font('Helvetica').fontSize(8)
         .text('Cabinet ADC&E Assurances · 5 allée de Tourny, 33000 Bordeaux · 0 800 014 033 · chasse.assurance@gmail.com',
               MARGIN_X, H - 27, { width: W - 2 * MARGIN_X, align: 'center' });
      doc.fillColor('#6abf7b').fontSize(7)
         .text('Document généré automatiquement — conservez-le précieusement', MARGIN_X, H - 14, { width: W - 2 * MARGIN_X, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateAttestation, generatePolicyNumber };
