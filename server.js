const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const path = require('path');
const PDFDocument = require('pdfkit');
const bcrypt = require('bcrypt');
const app = express();
const port = process.env.PORT || 3000;
const saltRounds = 10;

// Définir la date et l'heure actuelles (01:35 PM WAT, 14 juin 2025)
const currentDate = new Date('2025-06-14T13:35:00+01:00');

app.use(bodyParser.json());
app.use(express.static(__dirname));

// Helper function to read JSON file
async function readJsonFile(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    const parsedData = JSON.parse(data);
    return parsedData;
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur lecture ${filePath}:`, error.message, error.stack);
    throw new Error(`Une erreur est survenue lors de la lecture de ${path.basename(filePath)}.`);
  }
}

// Helper function to write JSON file
async function writeJsonFile(filePath, data) {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur écriture ${filePath}:`, error.message, error.stack);
    throw new Error('Une erreur est survenue, veuillez réessayer.');
  }
}

// Initialize JSON files if they don't exist
async function initializeFiles() {
  const files = [
    { path: 'classes.json', default: [] },
    { path: 'ress-ens.json', default: [] },
    { path: 'departments.json', default: [] },
    { path: 'filieres.json', default: [] },
    { path: 'students.json', default: [] },
    { path: 'constraints.json', default: [] },
    { path: 'documents.json', default: [] },
    {
      path: 'settings.json',
      default: { defaultTimeSlots: ['08:00-10:00', '10:00-12:00', '15:00-17:00'], maxClassesPerDay: 3, notificationEmail: '' }
    },
    {
      path: 'admin.json',
      default: [{ email: 'admin@stones.academy', password: await bcrypt.hash('Admin123', saltRounds), name: 'Administrateur Stones' }]
    }
  ];

  for (const file of files) {
    const filePath = path.join(__dirname, file.path);
    try {
      await fs.access(filePath);
      if (file.path === 'settings.json') {
        const data = await readJsonFile(filePath);
        if (!data.defaultTimeSlots || !Array.isArray(data.defaultTimeSlots) || data.defaultTimeSlots.length === 0) {
          console.warn(`[${currentDate.toISOString()}] settings.json est corrompu. Recréation avec les valeurs par défaut.`);
          await writeJsonFile(filePath, file.default);
        }
      }
    } catch {
      await writeJsonFile(filePath, file.default);
      console.log(`[${currentDate.toISOString()}] Fichier ${file.path} créé avec les données par défaut.`);
    }
  }
}

// Generate Timetable Endpoint
app.post('/api/generate-timetable', async (req, res) => {
  try {
    console.log(`[${currentDate.toISOString()}] Received request:`, req.body);
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ success: false, message: 'Corps de la requête manquant ou invalide' });
    }

    const { date, teacherId, filiere } = req.body;
    if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, message: 'Date requise au format YYYY-MM-DD' });
    }

    const filieres = await readJsonFile(path.join(__dirname, 'filieres.json'));
    const constraints = await readJsonFile(path.join(__dirname, 'constraints.json'));
    const professors = await readJsonFile(path.join(__dirname, 'ress-ens.json'));
    const classes = await readJsonFile(path.join(__dirname, 'classes.json'));

    if (!filieres.length || !professors.length || !classes.length) {
      return res.status(400).json({ success: false, message: 'Données insuffisantes pour générer l\'emploi du temps' });
    }

    const settings = await readJsonFile(path.join(__dirname, 'settings.json'));
    if (!settings.defaultTimeSlots || !Array.isArray(settings.defaultTimeSlots) || settings.defaultTimeSlots.length === 0) {
      console.error(`[${currentDate.toISOString()}] Erreur: defaultTimeSlots est manquant ou invalide dans settings.json`);
      return res.status(500).json({ success: false, message: 'Configuration des créneaux horaires par défaut invalide' });
    }

    const timeSlots = settings.defaultTimeSlots.map(slot => {
      const [start, end] = slot.split('-');
      return { time: slot, start, duration: 2 };
    });

    const days = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];

    let groups = filiere
      ? [filieres.find(f => f.name === filiere)].filter(Boolean).map(f => ({
          group: f.name,
          timetable: timeSlots.map(slot => ({
            time: slot.time,
            Lundi: '',
            Mardi: '',
            Mercredi: '',
            Jeudi: '',
            Vendredi: ''
          }))
        }))
      : filieres.map(f => ({
          group: f.name,
          timetable: timeSlots.map(slot => ({
            time: slot.time,
            Lundi: '',
            Mardi: '',
            Mercredi: '',
            Jeudi: '',
            Vendredi: ''
          }))
        }));

    for (const group of groups) {
      const filiereData = filieres.find(f => f.name === group.group);
      const availableSubjects = filiereData?.subjects || [];

      for (const slot of group.timetable) {
        const slotConstraints = constraints.filter(c => {
          const slotStart = slot.time.split('-')[0];
          return c.day === slot.time && c.time === slotStart && (c.group === group.group || c.type === 'Indisponible');
        });

        for (const day of days) {
          const dayConstraints = slotConstraints.filter(c => c.day === day);

          if (dayConstraints.some(c => c.type === 'Indisponible' && (c.group === group.group || c.teacher || c.room))) {
            slot[day] = 'Libre';
            continue;
          }

          const availableProfessors = professors.filter(p => !constraints.some(c =>
            c.day === day &&
            c.time === slot.time.split('-')[0] &&
            c.teacher === p.id &&
            c.type === 'Indisponible'
          ));

          const availableRooms = classes.filter(r => !constraints.some(c =>
            c.day === day &&
            c.time === slot.time.split('-')[0] &&
            c.room === r.name &&
            c.type === 'Indisponible'
          ));

          if (availableProfessors.length && availableRooms.length && availableSubjects.length) {
            const professor = availableProfessors[Math.floor(Math.random() * availableProfessors.length)];
            const room = availableRooms[Math.floor(Math.random() * availableRooms.length)];
            const subject = availableSubjects[Math.floor(Math.random() * availableSubjects.length)];

            slot[day] = `${subject} (${professor.name}, ${group.group}, ${room.name})`;
          } else {
            slot[day] = '-';
          }
        }
      }
    }

    groups.forEach(group => {
      group.timetable.splice(2, 0, {
        time: '12:00-13:00',
        Lundi: 'Pause',
        Mardi: 'Pause',
        Mercredi: 'Pause',
        Jeudi: 'Pause',
        Vendredi: 'Pause'
      });
    });

    if (teacherId) {
      const teacher = professors.find(p => p.id === teacherId);
      if (!teacher) {
        return res.status(400).json({ success: false, message: 'Enseignant non trouvé' });
      }

      const allTimetable = groups.flatMap(g => g.timetable);
      const teacherTimetable = allTimetable.filter(row =>
        days.some(day => row[day] && row[day].includes(teacher.name))
      );

      groups = [{
        group: `Enseignant_${teacher.name}`,
        timetable: teacherTimetable
      }];
    }

    res.json({ success: true, groups, professors });
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur génération emploi du temps:`, error.message, error.stack);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

// Export Timetable to PDF Endpoint
app.post('/api/export-pdf', async (req, res) => {
  try {
    const { timetables, date, group } = req.body;
    if (!timetables || !date || !group) {
      return res.status(400).json({ success: false, message: 'Emploi du temps, date et groupe requis' });
    }

    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    const filename = `timetable_${date}_${group.replace(/\s+/g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    doc.pipe(res);

    doc.fontSize(20).font('Helvetica-Bold').text(`Emploi du Temps - ${group}`, { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(`Semaine du ${date}`, { align: 'center' });
    doc.fontSize(10).text(`Généré le: ${currentDate.toLocaleString('fr-FR', { timeZone: 'Africa/Lagos' })}`, { align: 'right' });
    doc.moveDown(2);

    const tableTop = doc.y;
    const colWidths = [80, 90, 90, 90, 90, 90];
    const colPositions = [50, 130, 220, 310, 400, 490];
    const rowHeight = 40;
    const rowSpacing = 5;

    doc.fontSize(10).font('Helvetica-Bold').fillColor('white');
    doc.rect(50, tableTop, 500, rowHeight).fill('#333333');
    doc.fillColor('white');
    doc.text('Heure', colPositions[0], tableTop + 15, { width: colWidths[0] });
    doc.text('Lundi', colPositions[1], tableTop + 15, { width: colWidths[1] });
    doc.text('Mardi', colPositions[2], tableTop + 15, { width: colWidths[2] });
    doc.text('Mercredi', colPositions[3], tableTop + 15, { width: colWidths[3] });
    doc.text('Jeudi', colPositions[4], tableTop + 15, { width: colWidths[4] });
    doc.text('Vendredi', colPositions[5], tableTop + 15, { width: colWidths[5] });

    doc.font('Helvetica').fillColor('black');
    let currentY = tableTop + rowHeight + rowSpacing;
    timetables.forEach((row, index) => {
      if (index % 2 === 1) {
        doc.rect(50, currentY, 500, rowHeight).fill('#f8f9fa');
      }
      doc.fillColor('black');
      doc.text(row.time, colPositions[0], currentY + 10, { width: colWidths[0] });
      doc.text(row.Lundi || '-', colPositions[1], currentY + 10, { width: colWidths[1] });
      doc.text(row.Mardi || '-', colPositions[2], currentY + 10, { width: colWidths[2] });
      doc.text(row.Mercredi || '-', colPositions[3], currentY + 10, { width: colWidths[3] });
      doc.text(row.Jeudi || '-', colPositions[4], currentY + 10, { width: colWidths[4] });
      doc.text(row.Vendredi || '-', colPositions[5], currentY + 10, { width: colWidths[5] });
      doc.lineWidth(0.5).rect(50, currentY, 500, rowHeight).stroke();
      currentY += rowHeight + rowSpacing;

      if (row.time === '10:00-12:00') {
        doc.rect(50, currentY, 500, rowHeight).fill('#e9ecef');
        doc.fillColor('black');
        doc.text('12:00-13:00', colPositions[0], currentY + 10, { width: colWidths[0] });
        doc.text('Pause', colPositions[1], currentY + 10, { width: colWidths[1], align: 'center' });
        doc.text('Pause', colPositions[2], currentY + 10, { width: colWidths[2], align: 'center' });
        doc.text('Pause', colPositions[3], currentY + 10, { width: colWidths[3], align: 'center' });
        doc.text('Pause', colPositions[4], currentY + 10, { width: colWidths[4], align: 'center' });
        doc.text('Pause', colPositions[5], currentY + 10, { width: colWidths[5], align: 'center' });
        doc.lineWidth(0.5).rect(50, currentY, 500, rowHeight).stroke();
        currentY += rowHeight + rowSpacing;
      }
    });

    doc.lineWidth(1);
    doc.moveTo(50, tableTop).lineTo(550, tableTop).stroke();
    doc.moveTo(50, currentY).lineTo(550, currentY).stroke();
    colPositions.forEach((x, i) => {
      if (i < colPositions.length) {
        doc.moveTo(x, tableTop).lineTo(x, currentY).stroke();
      }
    });

    doc.end();
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur export PDF emploi du temps:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Logout Endpoint
app.post('/api/logout', async (req, res) => {
  try {
    const emploitDir = path.join(__dirname, 'emploit');
    await fs.rm(emploitDir, { recursive: true, force: true });
    await fs.mkdir(emploitDir);
    console.log(`[${currentDate.toISOString()}] Répertoire emploit nettoyé`);
    res.json({ success: true, message: 'Déconnexion réussie' });
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur déconnexion:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Salles Endpoints
app.get('/api/resources/classes', async (req, res) => {
  try {
    const classes = await readJsonFile(path.join(__dirname, 'classes.json'));
    res.json(classes);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/resources/classes', async (req, res) => {
  try {
    const classes = await readJsonFile(path.join(__dirname, 'classes.json'));
    const { name, capacity, equipment, lastUpdated } = req.body;
    if (!name || !capacity || !equipment) {
      return res.status(400).json({ success: false, message: 'Nom, capacité et équipements requis' });
    }
    if (classes.some(c => c.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Une salle avec ce nom existe déjà' });
    }
    const newId = `C${classes.length + 1}`;
    const newClass = { id: newId, name, capacity, equipment, lastUpdated: lastUpdated || currentDate.toISOString() };
    classes.push(newClass);
    await writeJsonFile(path.join(__dirname, 'classes.json'), classes);
    console.log(`[${currentDate.toISOString()}] Salle ajoutée:`, newClass);
    res.json(newClass);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/resources/classes/:id', async (req, res) => {
  try {
    const classes = await readJsonFile(path.join(__dirname, 'classes.json'));
    const index = classes.findIndex(c => c.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ success: false, message: 'Salle non trouvée' });
    }
    const { name, capacity, equipment, lastUpdated } = req.body;
    if (!name || !capacity || !equipment) {
      return res.status(400).json({ success: false, message: 'Nom, capacité et équipements requis' });
    }
    if (classes.some(c => c.id !== req.params.id && c.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Une salle avec ce nom existe déjà' });
    }
    classes[index] = { id: req.params.id, name, capacity, equipment, lastUpdated: lastUpdated || currentDate.toISOString() };
    await writeJsonFile(path.join(__dirname, 'classes.json'), classes);
    console.log(`[${currentDate.toISOString()}] Salle modifiée:`, classes[index]);
    res.json(classes[index]);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/resources/classes/:id', async (req, res) => {
  try {
    const classes = await readJsonFile(path.join(__dirname, 'classes.json'));
    const updatedClasses = classes.filter(c => c.id !== req.params.id);
    if (updatedClasses.length === classes.length) {
      return res.status(404).json({ success: false, message: 'Salle non trouvée' });
    }
    await writeJsonFile(path.join(__dirname, 'classes.json'), updatedClasses);
    console.log(`[${currentDate.toISOString()}] Salle supprimée:`, req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/resources/classes/export-pdf', async (req, res) => {
  try {
    const classes = await readJsonFile(path.join(__dirname, 'classes.json'));
    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=salles.pdf');
    doc.pipe(res);

    doc.fontSize(20).font('Helvetica-Bold').text('Liste des Salles - Stones Academy', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(`Généré le: ${currentDate.toLocaleString('fr-FR', { timeZone: 'Africa/Lagos' })}`, { align: 'right' });
    doc.moveDown(2);

    const tableTop = doc.y;
    const colWidths = [50, 150, 50, 150, 100];
    const colPositions = [50, 100, 250, 300, 450];
    const rowHeight = 30;
    const rowSpacing = 5;

    doc.fontSize(10).font('Helvetica-Bold').fillColor('white');
    doc.rect(50, tableTop, 500, rowHeight).fill('#333333');
    doc.fillColor('white');
    doc.text('ID', colPositions[0], tableTop + 10);
    doc.text('Nom', colPositions[1], tableTop + 10);
    doc.text('Capacité', colPositions[2], tableTop + 10);
    doc.text('Équipements', colPositions[3], tableTop + 10);
    doc.text('Dernière Mise à Jour', colPositions[4], tableTop + 10);

    doc.font('Helvetica').fillColor('black');
    let currentY = tableTop + rowHeight + rowSpacing;
    classes.forEach((cls, index) => {
      if (index % 2 === 1) {
        doc.rect(50, currentY, 500, rowHeight).fill('#f8f9fa');
      }
      doc.fillColor('black');
      doc.text(cls.id, colPositions[0], currentY + 10, { width: colWidths[0] });
      doc.text(cls.name, colPositions[1], currentY + 10, { width: colWidths[1] });
      doc.text(cls.capacity.toString(), colPositions[2], currentY + 10, { width: colWidths[2] });
      doc.text(cls.equipment, colPositions[3], currentY + 10, { width: colWidths[3] });
      doc.text(cls.lastUpdated ? new Date(cls.lastUpdated).toLocaleString('fr-FR') : '-', colPositions[4], currentY + 10, { width: colWidths[4] });
      doc.lineWidth(0.5).rect(50, currentY, 500, rowHeight).stroke();
      currentY += rowHeight + rowSpacing;
    });

    doc.lineWidth(1);
    doc.moveTo(50, tableTop).lineTo(550, tableTop).stroke();
    doc.moveTo(50, currentY).lineTo(550, currentY).stroke();
    colPositions.forEach((x, i) => {
      if (i < colPositions.length - 1) {
        doc.moveTo(x + colWidths[i], tableTop).lineTo(x + colWidths[i], currentY).stroke();
      }
    });
    doc.moveTo(50, tableTop).lineTo(50, currentY).stroke();
    doc.moveTo(550, tableTop).lineTo(550, currentY).stroke();

    doc.end();
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur export PDF salles:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Professeurs Endpoints
app.get('/api/resources/professors', async (req, res) => {
  try {
    const professors = await readJsonFile(path.join(__dirname, 'ress-ens.json'));
    res.status(200).json(professors);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/resources/professors', async (req, res) => {
  try {
    const professors = await readJsonFile(path.join(__dirname, 'ress-ens.json'));
    const { name, email, department, lastUpdated } = req.body;
    if (!name || !email || !department) {
      return res.status(400).json({ success: false, message: 'Nom, email et département sont requis' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Email non valide' });
    }
    if (professors.some(p => p.email.toLowerCase() === email.toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Un professeur avec cet email existe déjà' });
    }
    const newId = `P${professors.length + 1}`;
    const newProfessor = { id: newId, name, email, department, lastUpdated: lastUpdated || currentDate.toISOString() };
    professors.push(newProfessor);
    await writeJsonFile(path.join(__dirname, 'ress-ens.json'), professors);
    console.log(`[${currentDate.toISOString()}] Professeur ajouté:`, newProfessor);
    res.status(201).json(newProfessor);
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur ajout professeur:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/resources/professors/:id', async (req, res) => {
  try {
    const professors = await readJsonFile(path.join(__dirname, 'ress-ens.json'));
    const index = professors.findIndex(p => p.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ success: false, message: 'Professeur non trouvé' });
    }
    const { name, email, department, lastUpdated } = req.body;
    if (!name || !email || !department) {
      return res.status(400).json({ success: false, message: 'Nom, email et département sont requis' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Email non valide' });
    }
    if (professors.some(p => p.id !== req.params.id && p.email.toLowerCase() === email.toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Un professeur avec cet email existe déjà' });
    }
    professors[index] = { id: req.params.id, name, email, department, lastUpdated: lastUpdated || currentDate.toISOString() };
    await writeJsonFile(path.join(__dirname, 'ress-ens.json'), professors);
    console.log(`[${currentDate.toISOString()}] Professeur modifié:`, professors[index]);
    res.json(professors[index]);
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur modification professeur:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/resources/professors/:id', async (req, res) => {
  try {
    const professors = await readJsonFile(path.join(__dirname, 'ress-ens.json'));
    const updatedProfessors = professors.filter(p => p.id !== req.params.id);
    if (updatedProfessors.length === professors.length) {
      return res.status(404).json({ success: false, message: 'Professeur non trouvé' });
    }
    await writeJsonFile(path.join(__dirname, 'ress-ens.json'), updatedProfessors);
    console.log(`[${currentDate.toISOString()}] Professeur supprimé:`, req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur suppression professeur:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/resources/professors/export-pdf', async (req, res) => {
  try {
    const professors = await readJsonFile(path.join(__dirname, 'ress-ens.json'));
    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=professeurs.pdf');
    doc.pipe(res);

    doc.fontSize(20).font('Helvetica-Bold').text('Liste des Professeurs - Stones Academy', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(`Généré le: ${currentDate.toLocaleString('fr-FR', { timeZone: 'Africa/Lagos' })}`, { align: 'right' });
    doc.moveDown(2);

    const tableTop = doc.y;
    const colWidths = [50, 150, 150, 100, 100];
    const colPositions = [50, 100, 250, 400, 500];
    const rowHeight = 30;
    const rowSpacing = 5;

    doc.fontSize(10).font('Helvetica-Bold').fillColor('white');
    doc.rect(50, tableTop, 500, rowHeight).fill('#333333');
    doc.fillColor('white');
    doc.text('ID', colPositions[0], tableTop + 10);
    doc.text('Nom', colPositions[1], tableTop + 10);
    doc.text('Email', colPositions[2], tableTop + 10);
    doc.text('Département', colPositions[3], tableTop + 10);
    doc.text('Dernière Mise à Jour', colPositions[4], tableTop + 10);

    doc.font('Helvetica').fillColor('black');
    let currentY = tableTop + rowHeight + rowSpacing;
    professors.forEach((prof, index) => {
      if (index % 2 === 1) {
        doc.rect(50, currentY, 500, rowHeight).fill('#f8f9fa');
      }
      doc.fillColor('black');
      doc.text(prof.id, colPositions[0], currentY + 10, { width: colWidths[0] });
      doc.text(prof.name, colPositions[1], currentY + 10, { width: colWidths[1] });
      doc.text(prof.email, colPositions[2], currentY + 10, { width: colWidths[2] });
      doc.text(prof.department, colPositions[3], currentY + 10, { width: colWidths[3] });
      doc.text(prof.lastUpdated ? new Date(prof.lastUpdated).toLocaleString('fr-FR') : '-', colPositions[4], currentY + 10, { width: colWidths[4] });
      doc.lineWidth(0.5).rect(50, currentY, 500, rowHeight).stroke();
      currentY += rowHeight + rowSpacing;
    });

    doc.lineWidth(1);
    doc.moveTo(50, tableTop).lineTo(550, tableTop).stroke();
    doc.moveTo(50, currentY).lineTo(550, currentY).stroke();
    colPositions.forEach((x, i) => {
      if (i < colPositions.length - 1) {
        doc.moveTo(x + colWidths[i], tableTop).lineTo(x + colWidths[i], currentY).stroke();
      }
    });
    doc.moveTo(50, tableTop).lineTo(50, currentY).stroke();
    doc.moveTo(550, tableTop).lineTo(550, currentY).stroke();

    doc.end();
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur export PDF professeurs:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Départements Endpoints
app.get('/api/resources/departments', async (req, res) => {
  try {
    const departments = await readJsonFile(path.join(__dirname, 'departments.json'));
    res.json(departments);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/resources/departments', async (req, res) => {
  try {
    const departments = await readJsonFile(path.join(__dirname, 'departments.json'));
    const { name, head, volumeHoraire, lastUpdated } = req.body;
    if (!name || !head || volumeHoraire === undefined) {
      return res.status(400).json({ success: false, message: 'Nom, chef et volume horaire requis' });
    }
    if (isNaN(volumeHoraire) || volumeHoraire < 0) {
      return res.status(400).json({ success: false, message: 'Le volume horaire doit être un nombre positif' });
    }
    if (departments.some(d => d.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Un département avec ce nom existe déjà' });
    }
    const newId = `D${departments.length + 1}`;
    const newDepartment = { id: newId, name, head, volumeHoraire, lastUpdated: lastUpdated || currentDate.toISOString() };
    departments.push(newDepartment);
    await writeJsonFile(path.join(__dirname, 'departments.json'), departments);
    console.log(`[${currentDate.toISOString()}] Département ajouté:`, newDepartment);
    res.json(newDepartment);
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur ajout département:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/resources/departments/:id', async (req, res) => {
  try {
    const departments = await readJsonFile(path.join(__dirname, 'departments.json'));
    const index = departments.findIndex(d => d.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ success: false, message: 'Département non trouvé' });
    }
    const { name, head, volumeHoraire, lastUpdated } = req.body;
    if (!name || !head || volumeHoraire === undefined) {
      return res.status(400).json({ success: false, message: 'Nom, chef et volume horaire requis' });
    }
    if (isNaN(volumeHoraire) || volumeHoraire < 0) {
      return res.status(400).json({ success: false, message: 'Le volume horaire doit être un nombre positif' });
    }
    if (departments.some(d => d.id !== req.params.id && d.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Un département avec ce nom existe déjà' });
    }
    departments[index] = { id: req.params.id, name, head, volumeHoraire, lastUpdated: lastUpdated || currentDate.toISOString() };
    await writeJsonFile(path.join(__dirname, 'departments.json'), departments);
    console.log(`[${currentDate.toISOString()}] Département modifié:`, departments[index]);
    res.json(departments[index]);
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur modification département:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/resources/departments/:id', async (req, res) => {
  try {
    const departments = await readJsonFile(path.join(__dirname, 'departments.json'));
    const updatedDepartments = departments.filter(d => d.id !== req.params.id);
    if (updatedDepartments.length === departments.length) {
      return res.status(404).json({ success: false, message: 'Département non trouvé' });
    }
    await writeJsonFile(path.join(__dirname, 'departments.json'), updatedDepartments);
    console.log(`[${currentDate.toISOString()}] Département supprimé:`, req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur suppression département:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/resources/departments/export-pdf', async (req, res) => {
  try {
    const departments = await readJsonFile(path.join(__dirname, 'departments.json'));
    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=departements.pdf');
    doc.pipe(res);

    doc.fontSize(20).font('Helvetica-Bold').text('Liste des Départements - Stones Academy', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(`Généré le: ${currentDate.toLocaleString('fr-FR', { timeZone: 'Africa/Lagos' })}`, { align: 'right' });
    doc.moveDown(2);

    const tableTop = doc.y;
    const colWidths = [50, 150, 150, 50, 100];
    const colPositions = [50, 100, 250, 400, 450];
    const rowHeight = 30;
    const rowSpacing = 5;

    doc.fontSize(10).font('Helvetica-Bold').fillColor('white');
    doc.rect(50, tableTop, 500, rowHeight).fill('#333333');
    doc.fillColor('white');
    doc.text('ID', colPositions[0], tableTop + 10);
    doc.text('Nom', colPositions[1], tableTop + 10);
    doc.text('Chef', colPositions[2], tableTop + 10);
    doc.text('Volume H.', colPositions[3], tableTop + 10);
    doc.text('Dernière Mise à Jour', colPositions[4], tableTop + 10);

    doc.font('Helvetica').fillColor('black');
    let currentY = tableTop + rowHeight + rowSpacing;
    departments.forEach((dept, index) => {
      if (index % 2 === 1) {
        doc.rect(50, currentY, 500, rowHeight).fill('#f8f9fa');
      }
      doc.fillColor('black');
      doc.text(dept.id, colPositions[0], currentY + 10, { width: colWidths[0] });
      doc.text(dept.name, colPositions[1], currentY + 10, { width: colWidths[1] });
      doc.text(dept.head, colPositions[2], currentY + 10, { width: colWidths[2] });
      doc.text(dept.volumeHoraire ? dept.volumeHoraire.toString() : '-', colPositions[3], currentY + 10, { width: colWidths[3] });
      doc.text(dept.lastUpdated ? new Date(dept.lastUpdated).toLocaleString('fr-FR') : '-', colPositions[4], currentY + 10, { width: colWidths[4] });
      doc.lineWidth(0.5).rect(50, currentY, 500, rowHeight).stroke();
      currentY += rowHeight + rowSpacing;
    });

    doc.lineWidth(1);
    doc.moveTo(50, tableTop).lineTo(550, tableTop).stroke();
    doc.moveTo(50, currentY).lineTo(550, currentY).stroke();
    colPositions.forEach((x, i) => {
      if (i < colPositions.length - 1) {
        doc.moveTo(x + colWidths[i], tableTop).lineTo(x + colWidths[i], currentY).stroke();
      }
    });
    doc.moveTo(50, tableTop).lineTo(50, currentY).stroke();
    doc.moveTo(550, tableTop).lineTo(550, currentY).stroke();

    doc.end();
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur export PDF départements:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Filières Endpoints
app.get('/api/resources/filieres', async (req, res) => {
  try {
    const filieres = await readJsonFile(path.join(__dirname, 'filieres.json'));
    res.json(filieres);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/resources/filieres', async (req, res) => {
  try {
    const filieres = await readJsonFile(path.join(__dirname, 'filieres.json'));
    const { name, studentCount, subjects, lastUpdated } = req.body;
    if (!name || !subjects || studentCount === undefined) {
      return res.status(400).json({ success: false, message: 'Nom, matières et nombre d\'étudiants requis' });
    }
    if (isNaN(studentCount) || studentCount < 0) {
      return res.status(400).json({ success: false, message: 'Le nombre d\'étudiants doit être un nombre positif' });
    }
    if (filieres.some(f => f.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Une filière avec ce nom existe déjà' });
    }
    const newId = `F${filieres.length + 1}`;
    const newFiliere = { id: newId, name, studentCount, subjects, lastUpdated: lastUpdated || currentDate.toISOString() };
    filieres.push(newFiliere);
    await writeJsonFile(path.join(__dirname, 'filieres.json'), filieres);
    console.log(`[${currentDate.toISOString()}] Filière ajoutée:`, newFiliere);
    res.json(newFiliere);
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur ajout filière:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/resources/filieres/:id', async (req, res) => {
  try {
    const filieres = await readJsonFile(path.join(__dirname, 'filieres.json'));
    const index = filieres.findIndex(f => f.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ success: false, message: 'Filière non trouvée' });
    }
    const { name, studentCount, subjects, lastUpdated } = req.body;
    if (!name || !subjects || studentCount === undefined) {
      return res.status(400).json({ success: false, message: 'Nom, matières et nombre d\'étudiants requis' });
    }
    if (isNaN(studentCount) || studentCount < 0) {
      return res.status(400).json({ success: false, message: 'Le nombre d\'étudiants doit être un nombre positif' });
    }
    if (filieres.some(f => f.id !== req.params.id && f.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Une filière avec ce nom existe déjà' });
    }
    filieres[index] = { id: req.params.id, name, studentCount, subjects, lastUpdated: lastUpdated || currentDate.toISOString() };
    await writeJsonFile(path.join(__dirname, 'filieres.json'), filieres);
    console.log(`[${currentDate.toISOString()}] Filière modifiée:`, filieres[index]);
    res.json(filieres[index]);
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur modification filière:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/resources/filieres/:id', async (req, res) => {
  try {
    const filieres = await readJsonFile(path.join(__dirname, 'filieres.json'));
    const updatedFilieres = filieres.filter(f => f.id !== req.params.id);
    if (updatedFilieres.length === filieres.length) {
      return res.status(404).json({ success: false, message: 'Filière non trouvée' });
    }
    await writeJsonFile(path.join(__dirname, 'filieres.json'), updatedFilieres);
    console.log(`[${currentDate.toISOString()}] Filière supprimée:`, req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur suppression filière:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/resources/filieres/export-pdf', async (req, res) => {
  try {
    const filieres = await readJsonFile(path.join(__dirname, 'filieres.json'));
    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=filieres.pdf');
    doc.pipe(res);

    doc.fontSize(20).font('Helvetica-Bold').text('Liste des Filières - Stones Academy', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(`Généré le: ${currentDate.toLocaleString('fr-FR', { timeZone: 'Africa/Lagos' })}`, { align: 'right' });
    doc.moveDown(2);

    const tableTop = doc.y;
    const colWidths = [50, 150, 100, 150, 100];
    const colPositions = [50, 100, 250, 350, 500];
    const rowHeight = 30;
    const rowSpacing = 5;

    doc.fontSize(10).font('Helvetica-Bold').fillColor('white');
    doc.rect(50, tableTop, 500, rowHeight).fill('#333333');
    doc.fillColor('white');
    doc.text('ID', colPositions[0], tableTop + 10);
    doc.text('Nom', colPositions[1], tableTop + 10);
    doc.text('Nb Étudiants', colPositions[2], tableTop + 10);
    doc.text('Matières', colPositions[3], tableTop + 10);
    doc.text('Dernière Mise à Jour', colPositions[4], tableTop + 10);

    doc.font('Helvetica').fillColor('black');
    let currentY = tableTop + rowHeight + rowSpacing;
    filieres.forEach((filiere, index) => {
      if (index % 2 === 1) {
        doc.rect(50, currentY, 500, rowHeight).fill('#f8f9fa');
      }
      doc.fillColor('black');
      doc.text(filiere.id, colPositions[0], currentY + 10, { width: colWidths[0] });
      doc.text(filiere.name, colPositions[1], currentY + 10, { width: colWidths[1] });
      doc.text(filiere.studentCount.toString(), colPositions[2], currentY + 10, { width: colWidths[2] });
      doc.text(filiere.subjects.join(', '), colPositions[3], currentY + 10, { width: colWidths[3] });
      doc.text(filiere.lastUpdated ? new Date(filiere.lastUpdated).toLocaleString('fr-FR') : '-', colPositions[4], currentY + 10, { width: colWidths[4] });
      doc.lineWidth(0.5).rect(50, currentY, 500, rowHeight).stroke();
      currentY += rowHeight + rowSpacing;
    });

    doc.lineWidth(1);
    doc.moveTo(50, tableTop).lineTo(550, tableTop).stroke();
    doc.moveTo(50, currentY).lineTo(550, currentY).stroke();
    colPositions.forEach((x, i) => {
      if (i < colPositions.length - 1) {
        doc.moveTo(x + colWidths[i], tableTop).lineTo(x + colWidths[i], currentY).stroke();
      }
    });
    doc.moveTo(50, tableTop).lineTo(50, currentY).stroke();
    doc.moveTo(550, tableTop).lineTo(550, currentY).stroke();

    doc.end();
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur export PDF filières:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Étudiants Endpoints
app.get('/api/resources/students', async (req, res) => {
  try {
    const students = await readJsonFile(path.join(__dirname, 'students.json'));
    const validStudents = students.map(student => {
      return {
        id: student.id || `S${Date.now() + Math.floor(Math.random() * 1000)}`,
        name: student.name || 'Inconnu',
        email: student.email || '',
        filiere: student.filiere || '',
        password: student.password || '',
        lastUpdated: student.lastUpdated || currentDate.toISOString()
      };
    });
    res.json(validStudents);
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur lecture étudiants:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/resources/students', async (req, res) => {
  try {
    const students = await readJsonFile(path.join(__dirname, 'students.json'));
    const filieres = await readJsonFile(path.join(__dirname, 'filieres.json'));
    const { name, email, filiere, password } = req.body;
    if (!name || !email || !filiere || !password) {
      return res.status(400).json({ success: false, message: 'Nom, email, filière et mot de passe requis' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Email non valide' });
    }
    if (students.some(s => s.email.toLowerCase() === email.toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Un étudiant avec cet email existe déjà' });
    }
    if (!filieres.some(f => f.id === filiere)) {
      return res.status(400).json({ success: false, message: 'Filière non trouvée' });
    }
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const newId = `S${students.length + 1}`;
    const newStudent = { id: newId, name, email, filiere, password: hashedPassword, lastUpdated: currentDate.toISOString() };
    students.push(newStudent);
    await writeJsonFile(path.join(__dirname, 'students.json'), students);
    console.log(`[${currentDate.toISOString()}] Étudiant ajouté:`, { id: newId, name, email, filiere });
    res.json({ id: newId, name, email, filiere, lastUpdated: newStudent.lastUpdated });
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur ajout étudiant:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/resources/students/:id', async (req, res) => {
  try {
    const students = await readJsonFile(path.join(__dirname, 'students.json'));
    const filieres = await readJsonFile(path.join(__dirname, 'filieres.json'));
    const index = students.findIndex(s => s.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ success: false, message: 'Étudiant non trouvé' });
    }
    const { name, email, filiere, password } = req.body;
    if (!name || !email || !filiere) {
      return res.status(400).json({ success: false, message: 'Nom, email et filière requis' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Email non valide' });
    }
    if (students.some(s => s.id !== req.params.id && s.email.toLowerCase() === email.toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Un étudiant avec cet email existe déjà' });
    }
    if (!filieres.some(f => f.id === filiere)) {
      return res.status(400).json({ success: false, message: 'Filière non trouvée' });
    }
    const updatedStudent = {
      id: req.params.id,
      name,
      email,
      filiere,
      password: students[index].password,
      lastUpdated: currentDate.toISOString()
    };
    if (password) {
      updatedStudent.password = await bcrypt.hash(password, saltRounds);
    }
    students[index] = updatedStudent;
    await writeJsonFile(path.join(__dirname, 'students.json'), students);
    console.log(`[${currentDate.toISOString()}] Étudiant modifié:`, { id: req.params.id, name, email, filiere });
    res.json({ id: req.params.id, name, email, filiere, lastUpdated: updatedStudent.lastUpdated });
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur modification étudiant:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/resources/students/:id', async (req, res) => {
  try {
    const students = await readJsonFile(path.join(__dirname, 'students.json'));
    const updatedStudents = students.filter(s => s.id !== req.params.id);
    if (updatedStudents.length === students.length) {
      return res.status(404).json({ success: false, message: 'Étudiant non trouvé' });
    }
    await writeJsonFile(path.join(__dirname, 'students.json'), updatedStudents);
    console.log(`[${currentDate.toISOString()}] Étudiant supprimé:`, req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur suppression étudiant:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/resources/students/export-pdf', async (req, res) => {
  try {
    const students = await readJsonFile(path.join(__dirname, 'students.json'));
    const filieres = await readJsonFile(path.join(__dirname, 'filieres.json'));
    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=etudiants.pdf');
    doc.pipe(res);

    doc.fontSize(20).text('Liste des Étudiants - Stones Academy', { align: 'center' });
    doc.fontSize(10).text(`Généré le: ${currentDate.toLocaleString('fr-FR', { timeZone: 'Africa/Lagos' })}`, { align: 'right' });
    doc.moveDown(2);

    const tableTop = doc.y;
    const colWidths = [50, 150, 150, 100, 100];
    const colPositions = [50, 100, 250, 400, 500];
    const rowHeight = 30;
    const rowSpacing = 5;

    doc.fontSize(10).font('Helvetica-Bold').fillColor('white');
    doc.rect(50, tableTop, 500, rowHeight).fill('#333333');
    doc.fillColor('white');
    doc.text('ID', colPositions[0], tableTop + 10);
    doc.text('Nom', colPositions[1], tableTop + 10);
    doc.text('Email', colPositions[2], tableTop + 10);
    doc.text('Filière', colPositions[3], tableTop + 10);
    doc.text('Dernière Mise à Jour', colPositions[4], tableTop + 10);

    doc.font('Helvetica').fillColor('black');
    let currentY = tableTop + rowHeight + rowSpacing;
    students.forEach((student, index) => {
      if (index % 2 === 1) {
        doc.rect(50, currentY, 500, rowHeight).fill('#f8f9fa');
      }
      doc.fillColor('black');
      const filiereName = filieres.find(f => f.id === student.filiere)?.name || 'Non défini';
      doc.text(student.id || '', colPositions[0], currentY + 10, { width: colWidths[0] });
      doc.text(student.name || 'Inconnu', colPositions[1], currentY + 10, { width: colWidths[1] });
      doc.text(student.email || '', colPositions[2], currentY + 10, { width: colWidths[2] });
      doc.text(filiereName, colPositions[3], currentY + 10, { width: colWidths[3] });
      doc.text(student.lastUpdated ? new Date(student.lastUpdated).toLocaleString('fr-FR') : '-', colPositions[4], currentY + 10, { width: colWidths[4] });
      doc.lineWidth(0.5).rect(50, currentY, 500, rowHeight).stroke();
      currentY += rowHeight + rowSpacing;
    });

    doc.lineWidth(1);
    doc.moveTo(50, tableTop).lineTo(550, tableTop).stroke();
    doc.moveTo(50, currentY).lineTo(550, currentY).stroke();
    colPositions.forEach((x, i) => {
      if (i < colPositions.length - 1) {
        doc.moveTo(x + colWidths[i], tableTop).lineTo(x + colWidths[i], currentY).stroke();
      }
    });
    doc.moveTo(50, tableTop).lineTo(50, currentY).stroke();
    doc.moveTo(550, tableTop).lineTo(550, currentY).stroke();

    doc.end();
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur export PDF étudiants:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Contraintes Endpoints
app.get('/api/resources/constraints', async (req, res) => {
  try {
    const constraints = await readJsonFile(path.join(__dirname, 'constraints.json'));
    res.json(constraints);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/resources/constraints', async (req, res) => {
  try {
    const constraints = await readJsonFile(path.join(__dirname, 'constraints.json'));
    const { teacher, group, room, day, time, duration, volumeHoraire, type, subject, lastUpdated } = req.body;
    if (!teacher || !group || !room || !day || !time || !duration || !type || !subject) {
      return res.status(400).json({ success: false, message: 'Tous les champs sont requis' });
    }
    if (isNaN(duration) || duration <= 0 || duration > 8) {
      return res.status(400).json({ success: false, message: 'La durée doit être entre 1 et 8 heures' });
    }
    if (isNaN(volumeHoraire) || volumeHoraire < 0) {
      return res.status(400).json({ success: false, message: 'Le volume horaire doit être un nombre positif' });
    }
    if (!['Indisponible', 'Préférence'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Type invalide' });
    }

    const professors = await readJsonFile(path.join(__dirname, 'ress-ens.json'));
    const filieres = await readJsonFile(path.join(__dirname, 'filieres.json'));
    const classes = await readJsonFile(path.join(__dirname, 'classes.json'));
    if (!professors.some(p => p.id === teacher)) {
      return res.status(400).json({ success: false, message: 'Enseignant non trouvé' });
    }
    if (!filieres.some(f => f.name === group)) {
      return res.status(400).json({ success: false, message: 'Groupe non trouvé' });
    }
    if (!classes.some(c => c.name === room)) {
      return res.status(400).json({ success: false, message: 'Salle non trouvée' });
    }

    const [startHour, startMinute] = time.split(':').map(Number);
    const startTime = new Date();
    startTime.setHours(startHour, startMinute);
    const endTime = new Date(startTime.getTime() + duration * 60 * 60 * 1000);
    const conflict = constraints.some(c => {
      if (c.day !== day || c.id === req.body.id) return false;
      const [cStartHour, cStartMinute] = c.time.split(':').map(Number);
      const cStartTime = new Date();
      cStartTime.setHours(cStartHour, cStartMinute);
      const cEndTime = new Date(cStartTime.getTime() + c.duration * 60 * 60 * 1000);
      return (
        (c.teacher === teacher || c.group === group || c.room === room) &&
        (
          (startTime >= cStartTime && startTime < cEndTime) ||
          (endTime > cStartTime && endTime <= cEndTime) ||
          (startTime <= cStartTime && endTime >= cEndTime)
        )
      );
    });
    if (conflict) {
      return res.status(400).json({ success: false, message: 'Conflit d\'horaire détecté pour l\'enseignant, le groupe ou la salle.' });
    }

    const newId = req.body.id || `CON${constraints.length + 1}`;
    const newConstraint = { id: newId, teacher, group, room, day, time, duration, volumeHoraire, type, subject, lastUpdated: lastUpdated || currentDate.toISOString() };
    constraints.push(newConstraint);
    await writeJsonFile(path.join(__dirname, 'constraints.json'), constraints);
    console.log(`[${currentDate.toISOString()}] Contrainte ajoutée:`, newConstraint);
    res.json(newConstraint);
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur ajout contrainte:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/resources/constraints/:id', async (req, res) => {
  try {
    const constraints = await readJsonFile(path.join(__dirname, 'constraints.json'));
    const index = constraints.findIndex(c => c.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ success: false, message: 'Contrainte non trouvée' });
    }
    const { teacher, group, room, day, time, duration, volumeHoraire, type, subject, lastUpdated } = req.body;
    if (!teacher || !group || !room || !day || !time || !duration || !type || !subject) {
      return res.status(400).json({ success: false, message: 'Tous les champs sont requis' });
    }
    if (isNaN(duration) || duration <= 0 || duration > 8) {
      return res.status(400).json({ success: false, message: 'La durée doit être entre 1 et 8 heures' });
    }
    if (isNaN(volumeHoraire) || volumeHoraire < 0) {
      return res.status(400).json({ success: false, message: 'Le volume horaire doit être un nombre positif' });
    }
    if (!['Indisponible', 'Préférence'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Type invalide' });
    }

    const professors = await readJsonFile(path.join(__dirname, 'ress-ens.json'));
    const filieres = await readJsonFile(path.join(__dirname, 'filieres.json'));
    const classes = await readJsonFile(path.join(__dirname, 'classes.json'));

    if (!professors.some(p => p.id === teacher)) {
      return res.status(400).json({ success: false, message: 'Enseignant non trouvé' });
    }
    if (!filieres.some(f => f.name === group)) {
      return res.status(400).json({ success: false, message: 'Groupe non trouvé' });
    }
    if (!classes.some(c => c.name === room)) {
      return res.status(400).json({ success: false, message: 'Salle non trouvée' });
    }

    const [startHour, startMinute] = time.split(':').map(Number);
    const startTime = new Date();
    startTime.setHours(startHour, startMinute);
    const endTime = new Date(startTime.getTime() + duration * 60 * 60 * 1000);
    const conflict = constraints.some((c, i) => {
      if (c.day !== day || i === index) return false;
      const [cStartHour, cStartMinute] = c.time.split(':').map(Number);
      const cStartTime = new Date();
      cStartTime.setHours(cStartHour, cStartMinute);
      const cEndTime = new Date(cStartTime.getTime() + c.duration * 60 * 60 * 1000);
      return (
        (c.teacher === teacher || c.group === group || c.room === room) &&
        (
          (startTime >= cStartTime && startTime < cEndTime) ||
          (endTime > cStartTime && endTime <= cEndTime) ||
          (startTime <= cStartTime && endTime >= cEndTime)
        )
      );
    });
    if (conflict) {
      return res.status(400).json({ success: false, message: 'Conflit d\'horaire détecté pour l\'enseignant, le groupe ou la salle.' });
    }

    constraints[index] = { id: req.params.id, teacher, group, room, day, time, duration, volumeHoraire, type, subject, lastUpdated: lastUpdated || currentDate.toISOString() };
    await writeJsonFile(path.join(__dirname, 'constraints.json'), constraints);
    console.log(`[${currentDate.toISOString()}] Contrainte modifiée:`, constraints[index]);
    res.json(constraints[index]);
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur modification contrainte:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/resources/constraints/:id', async (req, res) => {
  try {
    const constraints = await readJsonFile(path.join(__dirname, 'constraints.json'));
    const updatedConstraints = constraints.filter(c => c.id !== req.params.id);
    if (updatedConstraints.length === constraints.length) {
      return res.status(404).json({ success: false, message: 'Contrainte non trouvée' });
    }
    await writeJsonFile(path.join(__dirname, 'constraints.json'), updatedConstraints);
    console.log(`[${currentDate.toISOString()}] Contrainte supprimée:`, req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur suppression contrainte:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Documents Endpoints
app.get('/api/resources/documents', async (req, res) => {
  try {
    const documents = await readJsonFile(path.join(__dirname, 'documents.json'));
    res.json(documents);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/resources/documents', async (req, res) => {
  try {
    const documents = await readJsonFile(path.join(__dirname, 'documents.json'));
    const { title, type, contentType, url } = req.body;
    if (!title || !contentType || !url) {
      return res.status(400).json({ success: false, message: 'Titre, type et URL requis' });
    }
    const newId = `DOC${documents.length + 1}`;
    const newDocument = { id: newId, title, contentType, url, lastUpdated: currentDate.toISOString() };
    documents.push(newDocument);
    await writeJsonFile(path.join(__dirname, 'documents.json'), documents);
    console.log(`[${currentDate.toISOString()}] Document ajouté:`, newDocument);
    res.json(newDocument);
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur ajout document:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/resources/documents/:id', async (req, res) => {
  try {
    const documents = await readJsonFile(path.join(__dirname, 'documents.json'));
    const updatedDocuments = documents.filter(d => d.id !== req.params.id);
    if (updatedDocuments.length === documents.length) {
      return res.status(404).json({ success: false, message: 'Document non trouvé' });
    }
    await writeJsonFile(path.join(__dirname, 'documents.json'), updatedDocuments);
    console.log(`[${currentDate.toISOString()}] Document supprimé:`, req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur suppression document:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Paramètres Endpoints
app.get('/api/resources/settings', async (req, res) => {
  try {
    const settings = await readJsonFile(path.join(__dirname, 'settings.json'));
    res.json(settings || { defaultTimeSlots: ['08:00-10:00', '10:00-12:00', '15:00-17:00'], maxClassesPerDay: 3, notificationEmail: '' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/resources/settings', async (req, res) => {
  try {
    const settings = req.body;
    if (!settings.defaultTimeSlots || !Array.isArray(settings.defaultTimeSlots) || settings.defaultTimeSlots.length === 0) {
      return res.status(400).json({ success: false, message: 'Les créneaux horaires par défaut doivent être un tableau non vide' });
    }
    for (const slot of settings.defaultTimeSlots) {
      if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(slot)) {
        return res.status(400).json({ success: false, message: `Format de créneau horaire invalide: ${slot}` });
      }
    }
    if (!Number.isInteger(settings.maxClassesPerDay) || settings.maxClassesPerDay < 1 || settings.maxClassesPerDay > 10) {
      return res.status(400).json({ success: false, message: 'Le nombre maximum de classes par jour doit être entre 1 et 10' });
    }
    if (settings.notificationEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.notificationEmail)) {
      return res.status(400).json({ success: false, message: 'Email de notification invalide' });
    }
    await writeJsonFile(path.join(__dirname, 'settings.json'), settings);
    console.log(`[${currentDate.toISOString()}] Paramètres mis à jour:`, settings);
    res.json({ success: true, message: 'Paramètres mis à jour' });
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur modification paramètres:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Login Admin
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const admins = await readJsonFile(path.join(__dirname, 'admin.json'));
    const admin = admins.find(a => a.email === email);
    if (admin && await bcrypt.compare(password, admin.password)) {
      console.log(`[${currentDate.toISOString()}] Connexion admin réussie:`, admin.email);
      res.json({ success: true, message: `Bienvenue, ${admin.email}!`, redirect: '/dashboard-admin.html', email: admin.email });
    } else {
      throw new Error('Email ou mot de passe incorrect');
    }
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur connexion admin:`, error.message, error.stack);
    res.status(400).json({ success: false, message: error.message });
  }
});

// Login Teacher
app.post('/api/login/teacher', async (req, res) => {
  try {
    const { email, password } = req.body;
    const professors = await readJsonFile(path.join(__dirname, 'ress-ens.json'));
    const teacher = professors.find(p => p.email.toLowerCase() === email.toLowerCase());

    if (!teacher) {
      return res.status(400).json({ success: false, message: 'Email ou mot de passe incorrect' });
    }

    if (!teacher.password) {
      return res.status(400).json({ success: false, message: 'Mot de passe non défini pour cet enseignant' });
    }

        const match = await bcrypt.compare(password, teacher.password);
    if (match) {
      console.log(`[${currentDate.toISOString()}] Connexion enseignant réussie:`, teacher.email);
      res.json({ success: true, message: `Bienvenue, ${teacher.name}!`, redirect: '/dashboard-teacher.html', email: teacher.email, id: teacher.id });
    } else {
      throw new Error('Email ou mot de passe incorrect');
    }
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur connexion enseignant:`, error.message, error.stack);
    res.status(400).json({ success: false, message: error.message });
  }
});

// Teacher Stats Endpoint
app.get('/api/teacher-stats', async (req, res) => {
  try {
    const professors = await readJsonFile(path.join(__dirname, 'ress-ens.json'));
    const constraints = await readJsonFile(path.join(__dirname, 'constraints.json'));
    const teacherId = req.query.id;

    if (!teacherId) {
      return res.status(400).json({ success: false, message: 'ID de l\'enseignant requis' });
    }

    const teacher = professors.find(p => p.id === teacherId);
    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Enseignant non trouvé' });
    }

    const teacherConstraints = constraints.filter(c => c.teacher === teacherId);
    const totalHours = teacherConstraints.reduce((sum, c) => sum + c.duration, 0);
    const unavailableHours = teacherConstraints.filter(c => c.type === 'Indisponible').reduce((sum, c) => sum + c.duration, 0);
    const availableHours = totalHours - unavailableHours;

    res.json({
      success: true,
      stats: {
        name: teacher.name,
        email: teacher.email,
        totalHours,
        availableHours,
        unavailableHours,
        lastUpdated: currentDate.toISOString()
      }
    });
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur chargement stats enseignant:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Teacher Timetable Endpoint
app.get('/api/teacher-timetable', async (req, res) => {
  try {
    const professors = await readJsonFile(path.join(__dirname, 'ress-ens.json'));
    const constraints = await readJsonFile(path.join(__dirname, 'constraints.json'));
    const teacherId = req.query.id;

    if (!teacherId) {
      return res.status(400).json({ success: false, message: 'ID de l\'enseignant requis' });
    }

    const teacher = professors.find(p => p.id === teacherId);
    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Enseignant non trouvé' });
    }

    const settings = await readJsonFile(path.join(__dirname, 'settings.json'));
    const timeSlots = settings.defaultTimeSlots.map(slot => {
      const [start, end] = slot.split('-');
      return { time: slot, start, duration: 2 };
    });

    const days = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
    const timetable = timeSlots.map(slot => ({
      time: slot.time,
      ...days.reduce((acc, day) => ({ ...acc, [day]: '' }), {})
    }));

    teacherConstraints.forEach(constraint => {
      const slotIndex = timeSlots.findIndex(s => s.start === constraint.time);
      if (slotIndex !== -1) {
        const dayIndex = days.indexOf(constraint.day);
        if (dayIndex !== -1) {
          timetable[slotIndex][constraint.day] = constraint.type === 'Indisponible'
            ? 'Indisponible'
            : `${constraint.subject} (${constraint.group}, ${constraint.room})`;
        }
      }
    });

    res.json({ success: true, timetable, name: teacher.name, lastUpdated: currentDate.toISOString() });
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur chargement emploi du temps enseignant:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Teacher Constraints Endpoint
app.get('/api/teacher-constraints', async (req, res) => {
  try {
    const constraints = await readJsonFile(path.join(__dirname, 'constraints.json'));
    const teacherId = req.query.id;

    if (!teacherId) {
      return res.status(400).json({ success: false, message: 'ID de l\'enseignant requis' });
    }

    const teacherConstraints = constraints.filter(c => c.teacher === teacherId);
    res.json(teacherConstraints);
  } catch (error) {
    console.error(`[${currentDate.toISOString()}] Erreur chargement contraintes enseignant:`, error.message, error.stack);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Start the server
initializeFiles().then(() => {
  app.listen(port, () => {
    console.log(`[${currentDate.toISOString()}] Serveur démarré sur le port ${port}`);
  });
}).catch(error => {
  console.error(`[${currentDate.toISOString()}] Erreur initialisation fichiers:`, error.message, error.stack);
  process.exit(1);
});